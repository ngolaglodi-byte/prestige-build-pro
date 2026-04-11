/**
 * Claude API + GPT-4 Mini helpers
 * Extracted from server.js lines 2106-2278
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

module.exports = function(ctx) {
  // These will be set after initialization via setDeps()
  let anthropicRequest, parseToolResponse, toolResponseToCode, cleanGeneratedContent, mergeEllipsis;
  let CODE_TOOLS, PROTECTED_FILES, writeGeneratedFiles;

  function setDeps(deps) {
    anthropicRequest = deps.anthropicRequest;
    parseToolResponse = deps.parseToolResponse;
    toolResponseToCode = deps.toolResponseToCode;
    cleanGeneratedContent = deps.cleanGeneratedContent;
    mergeEllipsis = deps.mergeEllipsis;
    CODE_TOOLS = deps.CODE_TOOLS;
    PROTECTED_FILES = deps.PROTECTED_FILES;
    writeGeneratedFiles = deps.writeGeneratedFiles;
  }

  // opts.useTools: if true, pass CODE_TOOLS and return parsed tool response
  // opts.rawResponse: if true, return the full API response object instead of text
  // opts.model: override the default model (Sonnet 4). Used for cheap routing (Haiku).
  function callClaudeAPI(systemBlocks, messages, maxTokens = 16000, trackingInfo = null, opts = {}) {
    return new Promise((resolve, reject) => {
      // Model routing: opts.model overrides the default. Used by classifyIntent (Haiku 4.5)
      // and reserved for future cheap-task routing (file selection, verify pass, etc.).
      const model = opts.model || 'claude-sonnet-4-20250514';
      const apiPayload = { model, max_tokens: maxTokens, system: systemBlocks, messages };
      if (opts.useTools) {
        apiPayload.tools = CODE_TOOLS;
        apiPayload.tool_choice = { type: 'auto' }; // let Claude decide when to use tools
      }
      const payload = JSON.stringify(apiPayload);

      // ── Job abort signal propagation ──
      let abortSignal = opts.signal || null;
      const linkedJobId = opts.jobId || trackingInfo?.jobId;
      if (!abortSignal && linkedJobId) {
        const linkedJob = ctx.generationJobs.get(linkedJobId);
        if (linkedJob && linkedJob.abortController) abortSignal = linkedJob.abortController.signal;
      }
      // Fast-fail if user already aborted before we even sent the request
      if (abortSignal && abortSignal.aborted) {
        const e = new Error('Requête annulée.');
        e.name = 'AbortError';
        reject(e);
        return;
      }

      const reqOpts = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': ctx.config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      if (abortSignal) reqOpts.signal = abortSignal;

      const { trackTokenUsage } = ctx.services.tokenTracking || {};

      anthropicRequest(payload, reqOpts, (apiRes) => {
        if (apiRes.statusCode !== 200) {
          let errBody = '';
          apiRes.on('data', c => errBody += c);
          apiRes.on('end', () => {
            console.error(`[callClaudeAPI] HTTP ${apiRes.statusCode}: ${errBody.substring(0, 300)}`);
            reject(new Error(`API HTTP ${apiRes.statusCode}`));
          });
          return;
        }
        let data = '';
        apiRes.on('data', c => data += c);
        apiRes.on('end', () => {
          try {
            const r = JSON.parse(data);
            if (trackingInfo && r.usage && trackTokenUsage) {
              trackTokenUsage(trackingInfo.userId, trackingInfo.projectId, trackingInfo.operation, model, r.usage);
            }

            // If tools were used, parse tool_use blocks
            const hasToolUse = r.content?.some(b => b.type === 'tool_use');
            if (hasToolUse) {
              const parsed = parseToolResponse(r);
              const fileCount = Object.keys(parsed.files).length;
              const editCount = parsed.edits.length;
              const serverCalls = parsed.serverToolCalls.length;
              console.log(`[callClaudeAPI] Tools: ${fileCount} write + ${editCount} edit + ${serverCalls} server, usage: ${JSON.stringify(r.usage || {})}`);

              // Continue conversation with tool results so Claude generates ALL files
              const allToolCalls = r.content.filter(b => b.type === 'tool_use');
              if (allToolCalls.length > 0 && (opts._depth || 0) < 8) {
                (async () => {
                  try {
                    const toolResults = [];
                    const projDir = trackingInfo?.projectId ? path.join(ctx.config.DOCKER_PROJECTS_DIR, String(trackingInfo.projectId)) : null;
                    for (const tc of allToolCalls) {
                      if (['write_file', 'edit_file', 'line_replace'].includes(tc.name)) {
                        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: `OK — ${tc.name} ${tc.input?.path || ''}` });
                      } else {
                        // Server-side tools: execute and return result
                        const input = { ...tc.input };
                        if (projDir) input._projectDir = projDir;
                        if (trackingInfo?.projectId) input.project_id = input.project_id || trackingInfo.projectId;
                        const executeServerTool = ctx.services.tools?.executeServerTool;
                        const result = executeServerTool ? await executeServerTool(tc.name, input) : 'OK';
                        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result || 'OK' });
                        console.log(`[ServerTool] ${tc.name}: ${(result || '').substring(0, 100)}`);
                      }
                    }
                    // Continue conversation with tool results
                    const currentCode = toolResponseToCode(parsed);
                    const followUp = await callClaudeAPI(systemBlocks, [
                      ...messages,
                      { role: 'assistant', content: r.content },
                      { role: 'user', content: toolResults }
                    ], maxTokens, trackingInfo, { ...opts, _depth: (opts._depth || 0) + 1 });
                    // Merge current files with continuation files
                    const merged = currentCode && followUp ? currentCode + '\n\n' + followUp : (followUp || currentCode || '');
                    resolve(merged);
                  } catch (e) {
                    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ERR_CANCELED')) {
                      reject(e);
                      return;
                    }
                    const code = toolResponseToCode(parsed);
                    resolve(code || parsed.text || '');
                  }
                })();
                return;
              }

              if (opts.rawResponse) { resolve(parsed); return; }
              const code = toolResponseToCode(parsed);
              resolve(code || parsed.text || '');
              return;
            }

            // Fallback: plain text response (### markers or conversation)
            const text = r.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
            if (text) {
              console.log(`[callClaudeAPI] Text: ${text.length} chars, usage: ${JSON.stringify(r.usage || {})}`);
              resolve(text);
            }
            else if (r.error) reject(new Error(r.error.message));
            else reject(new Error('Réponse API vide'));
          } catch (e) { reject(e); }
        });
        apiRes.on('error', reject);
      }, (e) => {
        console.error(`[callClaudeAPI] Request error: ${e.message}`);
        reject(e);
      }, null);
    });
  }

  // ─── GPT-4 MINI: Fast file selection (like Lovable's two-tier model) ───
  function callGPT4Mini(prompt, maxTokens = 500) {
    return new Promise((resolve, reject) => {
      if (!ctx.config.OPENAI_API_KEY) return reject(new Error('OPENAI_API_KEY not configured'));
      const payload = JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0
      });
      const req = https.request({
        hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.config.OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(data);
            if (r.error) return reject(new Error(r.error.message));
            const text = r.choices?.[0]?.message?.content || '';
            console.log(`[GPT-4 Mini] ${text.length} chars, ${r.usage?.total_tokens || 0} tokens`);
            resolve(text);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('GPT-4 Mini timeout')); });
      req.write(payload);
      req.end();
    });
  }

  // Select relevant files using GPT-4 Mini (fast, cheap) before sending to Claude Sonnet
  async function selectFilesWithLLM(projectStructure, userMessage) {
    let ai;
    try { ai = require('../ai'); } catch(e) {}
    if (!ctx.config.OPENAI_API_KEY || !ai) {
      return null;
    }
    try {
      const prompt = ai.buildFileSelectionPrompt(projectStructure, userMessage);
      const response = await callGPT4Mini(prompt);
      const files = ai.parseFileSelectionResponse(response);
      if (files.length > 0) {
        console.log(`[FileSelect] GPT-4 Mini selected ${files.length} files: ${files.join(', ')}`);
        return files;
      }
      return null;
    } catch (e) {
      console.warn(`[FileSelect] GPT-4 Mini failed: ${e.message} — falling back to regex`);
      return null;
    }
  }

  return { callClaudeAPI, callGPT4Mini, selectFilesWithLLM, setDeps };
};

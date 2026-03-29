# Lovable.dev Technical Architecture Research

**Date:** 2026-03-28
**Purpose:** Deep technical analysis for competitive reference

---

## 1. EXACT TECHNICAL ARCHITECTURE

### 1.1 LLM Strategy: Two-Tier Model Pipeline

Lovable uses a **hydration pattern** with two models:

1. **GPT-4 Mini** (OpenAI) -- fast initial processing, context preparation, file selection
2. **Claude 3.5 Sonnet** (Anthropic) -- main code generation, complex reasoning

The smaller model selects which files are relevant before handing off to the larger model. Key insight from their team: models "become more stupid when looking at too many things at once," so they use LLMs themselves to intelligently select relevant file subsets rather than feeding entire codebases.

They A/B tested Claude 3.5 Haiku but found GPT-4 Mini more cost-effective. Notably, they said if they switched to Haiku, "it would replace the larger Sonnet model rather than the smaller Mini" -- speed dominates their UX priorities.

### 1.2 Anti-Agentic Philosophy

Lovable explicitly **rejected** complex multi-agent architectures after testing them. Reasons:
- Lower accuracy and higher failure rates
- User confusion when failures occurred deep in agent chains
- Minutes of waiting before failures surfaced
- Philosophy: "as fast and as simple for the user to understand what's going on as possible"

This is a deliberate contrast to Replit Agent (multi-agent) and Devin (fully autonomous).

### 1.3 Code Generation: Tool-Based File Operations

From the leaked Agent Tools.json, Lovable uses **custom tool calls** (not raw text output). The AI generates structured tool invocations:

| Tool | Purpose | Details |
|------|---------|---------|
| `lov-write` | Create/overwrite files | Uses `// ... keep existing code` comments for unchanged sections >5 lines |
| `lov-line-replace` | Edit existing files | Line-number based search-replace with exact content matching |
| `lov-view` | Read files | Default first 500 lines, supports line ranges |
| `lov-search-files` | Regex search | Glob filtering, case sensitivity options |
| `lov-delete` | Remove files | By relative path |
| `lov-rename` | Rename files | Instead of create+delete |
| `lov-copy` | Duplicate files/dirs | Supports virtual filesystems |
| `lov-add-dependency` | npm install | Valid package name + version |
| `lov-remove-dependency` | npm uninstall | By package name |

**Key insight for our build:** They prefer `lov-line-replace` (surgical edits) over `lov-write` (full file rewrites). The system prompt instructs: "prefer search-replace over complete file rewrites." When using `lov-write`, unchanged sections >5 lines use ellipsis comments.

### 1.4 How Modifications Work

The flow is:
1. User sends chat message
2. GPT-4 Mini selects relevant files from project context
3. Claude 3.5 Sonnet receives selected files + user request + conversation history
4. Model outputs structured tool calls (`lov-write`, `lov-line-replace`, etc.)
5. Backend applies changes to cloud-hosted files
6. Diffs computed -- only modified lines transmitted
7. HMR (Hot Module Reloading) event triggered to user's browser session
8. Preview updates instantly via Vite HMR

They do NOT stream raw code text. They use tool_use/function_calling to get structured file operations.

### 1.5 Infrastructure

- **4,000+ instances on fly.io** -- ephemeral dev servers
- **Backend stack:** FastAPI, PostgreSQL, Redis, LangChain, Docker, Kubernetes
- **No WebContainers** -- unlike Bolt.new, Lovable uses cloud-hosted dev servers
- Each project gets a cloud Vite dev server
- Static SPA deployment via CDN for production
- Supabase for all backend services (DB, auth, storage, edge functions)

### 1.6 Conversation vs Code Separation

From the leaked system prompt:
- Default to **discussion mode** -- only write code when explicit action words are used ("implement," "create," "add")
- Ask clarifying questions FIRST, wait for response
- Verify requested features don't already exist before coding
- Keep explanations under 2 lines unless detail requested
- Chat mode (no code edits) costs 1 credit per message
- Build mode (code changes) costs 0.5-2.0 credits based on complexity

### 1.7 Error Handling & Auto-Fix

**User-facing:** "Try to Fix" button that:
- Scans console logs and network requests automatically
- Attempts a quick fix (claims ~60% success on simple issues)
- Is FREE (no credits consumed)
- Each subsequent manual "Fix" attempt DOES cost credits

**From the system prompt -- debugging protocol:**
1. Use `lov-read-console-logs` FIRST (before examining code)
2. Use `lov-read-network-requests` for API issues
3. Then examine relevant code files
4. Search web for current information if needed

**Internal prompt engineering process:**
1. Diagnose why the AI failed on a production issue
2. Modify prompts to address the pattern
3. Run extensive back-tests against historical queries
4. Verify no regressions before rollout
5. Philosophy: "Start extremely simple; add complexity only when necessary"

---

## 2. USER-FACING FEATURES

### 2.1 Project Creation Flow

1. User describes what they want in natural language
2. For first message with blank template, the AI:
   - Articulates what user wants to build + design inspiration
   - Lists specific features for first version
   - Specifies colors, gradients, animations, fonts
   - Implements a design system immediately
   - Ensures valid TypeScript and zero build errors
3. Generates full React/Vite/Tailwind/TypeScript project
4. Preview appears in right panel within seconds

### 2.2 Chat Interface

- Left panel: chat conversation
- Right panel: live preview (iframe)
- AI uses `lov-` prefixed XML tags for custom rendering in chat
- Mermaid diagrams for architecture/workflow explanations
- Minimal emoji usage (explicit rule in prompt)
- Short, concise responses (under 2 lines default)

### 2.3 Real-Time Preview

- **Vite-powered HMR** -- sub-second updates for style changes
- Changes applied optimistically via client-side Tailwind generator
- Custom Vite plugin assigns stable IDs to JSX components at compile time
- Bidirectional linking: click element in preview -> jumps to JSX source
- Time slicing prevents browser freezing on large diffs
- Code synced to browser as AST (Abstract Syntax Tree) using Babel/SWC
- Preview runs on fly.io ephemeral instances

### 2.4 Visual Editing (Figma-like)

- Direct manipulation of elements in preview
- AST-based modifications (not regex)
- Changes generate clean JSX/TSX
- Does NOT consume AI credits for visual tweaks
- Covers: colors, spacing, sizing, layout, text

### 2.5 Deployment/Publish

- One-click "Publish" deploys to lovable.app subdomain
- Custom domains on Pro plan
- GitHub sync enables deployment to: Vercel, Netlify, AWS, any host
- Supabase backend deployed automatically
- No native dev/staging/prod separation (major enterprise limitation)

### 2.6 GitHub Integration

- Two-way sync: Lovable edits -> GitHub, GitHub edits -> Lovable
- Automatic commits to repository
- Branch management and preview deployments
- Pull request workflows supported
- WARNING: Cannot rename/move/delete GitHub repo after connecting (breaks sync)

### 2.7 Collaboration (2026)

- Real-time multi-user editing for up to 20 collaborators (added Feb 2026)
- Workspace feature for team management
- Role-based permissions
- Shared billing
- Designed for startups and small teams

---

## 3. TOKEN/CREDIT MANAGEMENT

### 3.1 Credit System

Credits are usage-based, varying by complexity:

| Action | Credit Cost |
|--------|-------------|
| Simple edit ("Make the button gray") | ~0.50 credits |
| Component removal | ~0.90 credits |
| Feature addition (auth) | ~1.20 credits |
| Complex build (landing page with images) | ~2.00 credits |
| Chat-only message (no code) | 1.00 credit |

### 3.2 Plan Tiers

| Plan | Price | Credits | Key Features |
|------|-------|---------|--------------|
| Free | $0 | 5/day (max 30/month) | Public projects only, 5 lovable.app domains |
| Pro | $25/mo | 100/month (up to 150) | Private projects, custom domains, rollover, remove badge |
| Business | $50/mo | 200/month | SSO, design templates, personal workspaces, opt-out data training |
| Enterprise | Custom | Custom | Dedicated support, onboarding, advanced controls |

### 3.3 Credit Rules

- **Daily credits (Free):** Do NOT roll over day-to-day
- **Monthly credits (Pro/Business):** DO roll over month-to-month while subscription active
- **Top-ups:** 50-credit increments, $15/50 (Pro), $30/50 (Business), valid 12 months
- **On cancellation:** All unused + rollover credits expire at end of billing period
- **Student discount:** 50% off Pro plan

---

## 4. PROMPT ENGINEERING (FROM LEAKS)

### 4.1 System Prompt Structure

The leaked prompt (~304 lines, 19.8KB) contains:

**Identity block:**
> "Lovable is an AI editor that creates and modifies web applications, assisting users by chatting with them and making changes to their code in real-time."

**Stack constraints:**
> "Lovable projects are built on top of React, Vite, Tailwind CSS, and TypeScript"

**8-Step Required Workflow:**
1. Check useful-context section FIRST
2. Never read files already in context
3. Batch multiple file operations simultaneously
4. Never make sequential tool calls when combinable
5. Default to discussion mode (only code with action words)
6. Ask clarifying questions first
7. Verify features don't already exist
8. Keep explanations under 2 lines

### 4.2 Design System Rules

- Define ALL styles in `index.css` and `tailwind.config.ts` using HSL values only
- Never use inline classes like `text-white`, `bg-white`
- Create semantic design tokens for colors, gradients, shadows, animations
- Customize shadcn components through variants, not overrides
- Small, focused components -- never monolithic files

### 4.3 Code Conventions

- No environment variables (VITE_* unsupported in their runtime)
- Secrets handled via `secrets--add_secret` tool (encrypted, for edge functions only)
- Valid TypeScript required -- zero build errors
- Avoid edge cases and features not explicitly requested

### 4.4 Additional Tools in System

| Tool | Purpose |
|------|---------|
| `imagegen--generate_image` | AI image generation (flux.schnell/flux.dev) |
| `imagegen--edit_image` | Modify/merge images |
| `websearch--web_search` | Search with category filters |
| `lov-fetch-website` | Convert pages to markdown |
| `lov-download-to-repo` | Download files into project |
| `supabase--docs-search` | Search Supabase docs |
| `supabase--docs-get` | Get full Supabase doc pages |
| `document--parse_document` | Parse PDFs, Word, Excel, audio |
| `analytics--read_project_analytics` | Production metrics |
| `stripe--enable_stripe` | Payment integration |
| `security--run_security_scan` | Supabase RLS/security audit |
| `security--get_table_schema` | DB schema + security analysis |

---

## 5. COMPETITOR COMPARISON

### 5.1 Bolt.new

| Aspect | Lovable | Bolt.new |
|--------|---------|----------|
| **Runtime** | Cloud servers (fly.io, 4000+ instances) | In-browser WebContainer (WASM) |
| **Cost model** | They pay for cloud compute per user | User's browser does the compute |
| **Stack** | React/Vite/Tailwind only | Any Node.js framework |
| **LLM** | GPT-4 Mini + Claude 3.5 Sonnet (two-tier) | Claude 3.5 Sonnet (single model) |
| **Code gen** | Structured tool calls (lov-write, lov-line-replace) | Streaming artifacts parsed by EnhancedStreamingMessageParser |
| **File system** | Cloud-hosted real files | Rust-based virtual FS compiled to WASM, SharedArrayBuffer |
| **npm install** | Cloud server | Pre-compressed CDN packages, <500ms in browser |
| **Backend** | Supabase only | Bolt Cloud (2025+) with built-in DB, auth, hosting |
| **Speed feel** | Fast (cloud HMR) | "Feels like localhost" (no network roundtrip) |
| **Agent design** | Anti-agentic, single-pass | Single prompt architecture, no chains |
| **Business** | $4.7B valuation | $0 to $40M ARR in 6 months, 15-person team |

**Bolt's unique technical advantage:** Rust-based virtual filesystem using SharedArrayBuffer for direct memory access across Web Workers, with Atomics API for file locking. Custom JSH shell (TypeScript) replaces Bash. Service Worker intercepts localhost URLs, routes to Web Workers. This eliminates cloud server costs entirely.

### 5.2 v0.dev (Vercel)

| Aspect | Lovable | v0.dev |
|--------|---------|--------|
| **Scope** | Full-stack apps | UI components + pages (expanding to full-stack) |
| **Stack** | React/Vite/Tailwind | Next.js/React/Tailwind/shadcn (locked to Next.js) |
| **Output** | Full project with routing, state, backend | Components and pages, copy-paste or CLI install |
| **Component system** | shadcn/ui (copied into project) | shadcn/ui (native, since Vercel built it) |
| **Multi-framework** | React only | React, Svelte, Vue, HTML+CSS via Blocks |
| **Deployment** | lovable.app or GitHub export | Vercel (native integration) |
| **Strength** | Rapid full-app prototyping | Highest-quality UI component generation |
| **Weakness** | Backend limited to Supabase | Not designed for full applications |

### 5.3 Replit Agent

| Aspect | Lovable | Replit Agent |
|--------|---------|--------------|
| **Architecture** | Anti-agentic (single-pass) | Multi-agent (manager/editor/verifier) |
| **LLM** | GPT-4 Mini + Claude 3.5 Sonnet | Claude 3.5 Sonnet (primary) + GPT-4 Mini (compression) |
| **Tool calling** | Standard function/tool_use | Custom Python DSL generated by LLM (~90% success rate) |
| **Languages** | React/TypeScript only | 50+ languages |
| **Backend** | Supabase only | Built-in with real databases |
| **Error recovery** | "Try to Fix" button, log scanning | 3-tier: retry with feedback -> reflection every 5 steps -> human escalation |
| **Context mgmt** | LLM selects relevant files | Truncation + LLM compression of long trajectories |
| **Hosting** | External (fly.io) | Built-in (run on Replit) |
| **Scope isolation** | Single model sees everything selected | Each sub-agent gets minimum necessary tools |
| **Evaluation** | Back-testing against historical queries | LangSmith tracing + trajectory replay |

**Replit's unique advantage:** The Python DSL approach for tool calling is clever -- they let the LLM generate a stripped-down Python script instead of JSON function calls, achieving ~90% valid tool call rate. Their verifier agent can take screenshots, run static checks, and interact with the app to validate changes.

### 5.4 Summary Matrix

| Feature | Lovable | Bolt.new | v0.dev | Replit Agent |
|---------|---------|----------|--------|--------------|
| Full-stack | Partial (Supabase) | Yes (WebContainer) | No (UI focus) | Yes (native) |
| Runtime | Cloud (fly.io) | Browser (WASM) | Cloud | Cloud (Replit) |
| Multi-lang | No | JS/TS only | No | Yes (50+) |
| Agent complexity | Simple (single-pass) | Simple (single prompt) | Simple | Complex (multi-agent) |
| Visual editing | Yes (AST-based) | No | No | No |
| GitHub sync | Two-way | Export only | CLI install | Two-way |
| Collaboration | Real-time (20 users) | No | No | Yes (Replit multiplayer) |
| Free tier | 5 credits/day | Limited tokens | Limited generations | Limited |
| Price entry | $25/mo | $20/mo | $20/mo | $25/mo |

---

## 6. KEY TAKEAWAYS FOR OUR BUILD

### What Lovable Gets Right
1. **Two-tier model approach** -- fast context selection + powerful generation
2. **Structured tool calls** -- not raw text, proper file operation tools
3. **Surgical edits** -- `lov-line-replace` over full file rewrites
4. **AST-based visual editing** -- bidirectional code<->preview mapping
5. **HMR-based preview** -- sub-second feedback loop
6. **Opinionated stack** -- constraining to React/Vite/Tailwind improves AI accuracy
7. **Anti-agentic simplicity** -- faster, more predictable than multi-agent

### What Lovable Gets Wrong
1. **Bug loops consume credits** -- users complain about paying for AI-caused errors
2. **Supabase-only backend** -- major limitation for enterprise
3. **No environment separation** -- no dev/staging/prod
4. **Edge function reliability** -- known issues with non-working edge functions
5. **Code quality degradation** -- incremental AI changes accumulate complexity
6. **Security concerns** -- RLS misconfiguration risks, API key exposure in client code

### Architecture Decisions to Consider
1. **Cloud servers vs WebContainer:** Lovable chose cloud (simpler, more reliable) over Bolt's browser approach (faster, cheaper). Our Docker approach is closer to Lovable's model.
2. **Single-pass vs multi-agent:** Lovable's single-pass + tool calls is simpler and more reliable than Replit's multi-agent. Worth starting here.
3. **File modification strategy:** Use search-replace/line-replace as primary, full-file-write as fallback. Never regex -- use AST when possible.
4. **Error recovery:** Auto-detect build errors, feed them back to AI, but cap retry attempts to avoid credit drain.
5. **Context management:** Do NOT feed entire codebase to LLM. Use a fast model to select relevant files first.

// Re-export Sonner's toast for convenience
// Usage: import { toast } from "sonner" (recommended)
//    or: import { useToast } from "@/hooks/useToast"
import { toast } from "sonner";

export function useToast() {
  return { toast };
}

export { toast };

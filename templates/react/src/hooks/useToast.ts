// Re-export Sonner's toast for backward compatibility
// Usage: import { toast } from "sonner" directly, or:
//        import { useToast } from "../hooks/useToast"
//        const { toast } = useToast()
import { toast } from "sonner";

export function useToast() {
  return { toast };
}

export { toast };

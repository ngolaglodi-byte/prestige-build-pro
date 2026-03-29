import { Toaster as SonnerToaster } from "sonner";

function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: "var(--color-background)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
        },
      }}
      richColors
      closeButton
    />
  );
}

export { Toaster };

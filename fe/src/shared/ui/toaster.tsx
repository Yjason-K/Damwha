import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/shared/ui/toast";
import {
  dismissToast,
  useToast,
  type ToastVariant,
} from "@/shared/ui/use-toast";

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function ToastIcon({ variant }: { variant: ToastVariant }) {
  const tone =
    variant === "success"
      ? "text-[#6ecfa6]"
      : variant === "error"
        ? "text-[#f795a8]"
        : "text-[color:var(--accent-6)]";
  return (
    <span className={`mt-px inline-flex shrink-0 ${tone} [&_svg]:size-4`}>
      {variant === "success" ? (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      ) : variant === "error" ? (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 4.5v4M8 11h.01" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 7.5v4M8 5h.01" />
        </svg>
      )}
    </span>
  );
}

/** Mount once near the app root; renders the active toast queue. */
export function Toaster() {
  const { toasts } = useToast();
  return (
    <ToastProvider swipeDirection="right">
      {toasts.map(
        ({ id, title, description, variant = "info", action, duration }) => (
          <Toast
            key={id}
            duration={duration ?? 5000}
            onOpenChange={(open) => {
              if (!open) dismissToast(id);
            }}
          >
            <ToastIcon variant={variant} />
            <div className="min-w-0 flex-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action && (
              <ToastAction altText={action.label} onClick={action.onClick}>
                {action.label}
              </ToastAction>
            )}
            <ToastClose>
              <CloseIcon />
            </ToastClose>
          </Toast>
        ),
      )}
      <ToastViewport />
    </ToastProvider>
  );
}

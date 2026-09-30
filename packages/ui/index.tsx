import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { ArrowUpRight, X } from "lucide-react";

/** The few strings these components render themselves. Host apps provide translations. */
export interface UiText {
  closeDialog: string;
  designDemo: string;
}
const defaultUiText: UiText = { closeDialog: "Close dialog", designDemo: "DESIGN DEMO" };
const UiTextContext = createContext<UiText>(defaultUiText);
export function UiTextProvider({ value, children }: { value: Partial<UiText>; children: ReactNode }) {
  return <UiTextContext.Provider value={{ ...defaultUiText, ...value }}>{children}</UiTextContext.Provider>;
}
export function Button({
  variant = "",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return <button className={`button ${variant} ${className}`} {...props} />;
}
export function TextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="text-link" href={href}>
      {children}
      <ArrowUpRight size={15} />
    </a>
  );
}
export function Section({
  id,
  eyebrow,
  title,
  children,
  className = "",
}: {
  id?: string;
  eyebrow?: string;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`section ${className}`}>
      <div className="container">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </section>
  );
}
export function Surface({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`surface ${className}`}>{children}</div>;
}
export type DataState =
  "loading" | "live" | "stale" | "unavailable" | "demo" | "warning" | "error";
export function Status({
  state,
  children,
}: {
  state: DataState;
  children?: ReactNode;
}) {
  return <span className={`status ${state}`}>{children ?? state}</span>;
}
export function DemoBadge() {
  const text = useContext(UiTextContext);
  return <span className="demo-badge">{text.designDemo}</span>;
}
export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
export function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="code">
      <code>{children}</code>
    </pre>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const text = useContext(UiTextContext);
  useEffect(() => {
    const el = ref.current;
    if (open && !el?.open) el?.showModal();
    else if (!open && el?.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-top">
        <h2>{title}</h2>
        <Button
          variant="ghost icon"
          aria-label={text.closeDialog}
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/** Router-independent application chrome; host apps supply navigation and state. */
export function RougeAppShell({
  brand,
  product,
  proposedHost,
  globalNavigation,
  localNavigation,
  network,
  actions,
}: {
  brand: ReactNode;
  product: string;
  proposedHost: string;
  globalNavigation: ReactNode;
  localNavigation: ReactNode;
  network: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className="header rouge-app-shell">
      <div className="container header-inner">
        <div className="app-brand">
          {brand}
          <span className="product-label">{product}</span>
        </div>
        <div className="shell-actions">
          {network}
          {globalNavigation}
          {actions}
        </div>
      </div>
      {(localNavigation || proposedHost) && (
        <div className="container shell-subnav">
          {localNavigation}
          {proposedHost && <span className="proposed-host">{proposedHost}</span>}
        </div>
      )}
    </header>
  );
}

import { Check } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

const ITEMS = '[role^="menuitem"]:not(:disabled)';

type MenuProps = {
  // The button's accessible name and its tooltip.
  label: string;
  // What the button shows (an icon, initials) and its classes.
  button: ReactNode;
  buttonClassName?: string;
  // Where the menu opens: below the button (headers) or above it (the foot of the side list).
  side?: "bottom" | "top";
  align?: "start" | "end";
  className?: string;
  // In a strip that scrolls (the tabs) a menu placed under its button would be cut off: placed on
  // the screen instead, by the button, it closes when anything scrolls or the window is resized.
  fixed?: boolean;
  disabled?: boolean;
  // Changes when the menu shows another list in place of the first: its first item takes the focus.
  view?: string;
  // Told when the menu closes, however it closes.
  onClosed?: () => void;
  // The items; `close` closes the menu and gives the focus back to the button.
  children: (close: () => void) => ReactNode;
};

// A button that opens a list of actions (R-UI-1): Esc, a click outside or Tab close it; the arrows,
// Home and End move between the items and Enter or Space choose. Built on plain elements, like
// the rest of the kit, so it needs no library.
export function Menu({
  label,
  button,
  buttonClassName,
  side = "bottom",
  align = "end",
  className,
  fixed = false,
  disabled = false,
  view,
  onClosed,
  children,
}: MenuProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = (value: boolean) => {
    setOpenState(value);
    if (!value) {
      onClosed?.();
    }
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [place, setPlace] = useState<CSSProperties>();

  function toggle() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!open && fixed && rect) {
      setPlace({
        ...(side === "bottom"
          ? { top: rect.bottom + 4 }
          : { bottom: window.innerHeight - rect.top + 4 }),
        ...(align === "end" ? { right: window.innerWidth - rect.right } : { left: rect.left }),
      });
    }
    setOpen(!open);
  }

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  // Opened, or showing another list: the item already chosen takes the focus, else the first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new list is a new view
  useEffect(() => {
    const menu = menuRef.current;
    const first =
      menu?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      menu?.querySelector<HTMLElement>(ITEMS);
    first?.focus();
  }, [open, view]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen only sets the state
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    // Scrolling inside the menu (a long list) keeps it open.
    const onMoved = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    if (fixed) {
      window.addEventListener("scroll", onMoved, true);
      window.addEventListener("resize", onMoved);
    }
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onMoved, true);
      window.removeEventListener("resize", onMoved);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") {
      next = items[(index + 1) % items.length];
    } else if (event.key === "ArrowUp") {
      next = items[(index - 1 + items.length) % items.length];
    } else if (event.key === "Home") {
      next = items[0];
    } else if (event.key === "End") {
      next = items[items.length - 1];
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    } else if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        className={buttonClassName}
        onClick={toggle}
      >
        {button}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          style={fixed ? place : undefined}
          className={cn(
            "z-50 min-w-56 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg",
            fixed ? "fixed" : "absolute",
            !fixed && (side === "bottom" ? "top-full mt-1" : "bottom-full mb-1"),
            !fixed && (align === "end" ? "right-0" : "left-0"),
            className,
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  // A choice among several (a theme, a width): shown with a check when it is the current one.
  checked?: boolean;
  // What sits at the end of the row: the current choice, an arrow to a sub-list.
  end?: ReactNode;
};

export function MenuItem({ icon, checked, end, className, children, ...props }: MenuItemProps) {
  const radio = checked !== undefined;
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is set only on the menuitemradio role
    <button
      type="button"
      role={radio ? "menuitemradio" : "menuitem"}
      aria-checked={radio ? checked : undefined}
      tabIndex={-1}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none",
        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {radio ? (
        <Check className={cn(!checked && "invisible")} aria-hidden />
      ) : icon ? (
        <span className="text-muted-foreground">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end ? <span className="flex items-center gap-1 text-muted-foreground">{end}</span> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{children}</p>;
}

export function MenuSeparator() {
  return <hr className="-mx-1 my-1 border-border" />;
}

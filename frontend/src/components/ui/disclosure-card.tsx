import { useId, type ReactNode } from "react";

import { cn } from "../../lib";
import "./dashboard.css";

export function DisclosureCard({
  title,
  titleId,
  description,
  expanded,
  onExpandedChange,
  className,
  children,
}: {
  title: string;
  titleId: string;
  description?: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const contentId = useId();
  return (
    <section aria-labelledby={titleId} className={cn("ui-disclosure-card", className)}>
      <h2 className="ui-disclosure-heading">
        <button
          type="button"
          className="ui-disclosure-trigger"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-labelledby={titleId}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span className="ui-disclosure-chevron" aria-hidden="true" />
          <span>
            <span id={titleId}>{title}</span>
            {description ? <span className="ui-disclosure-description">{description}</span> : null}
          </span>
        </button>
      </h2>
      <div id={contentId} className="ui-disclosure-content" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}

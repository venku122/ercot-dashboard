import { useId, type HTMLAttributes, type ReactNode } from "react";

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
  headingLevel = 2,
  ...sectionProps
}: {
  title: string;
  titleId: string;
  description?: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  className?: string;
  children: ReactNode;
  headingLevel?: 2 | 3 | 4;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "children">) {
  const contentId = useId();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <section
      {...sectionProps}
      aria-labelledby={titleId}
      className={cn("ui-disclosure-card", className)}
    >
      <Heading className="ui-disclosure-heading">
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
      </Heading>
      <div id={contentId} className="ui-disclosure-content" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}

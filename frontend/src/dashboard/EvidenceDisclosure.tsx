import { useId, useState, type ReactNode } from "react";
import { DisclosureCard } from "../components/ui/disclosure-card";

// The evidence is already owned/loaded by the domain parent; toggling performs no I/O.
export function EvidenceDisclosure({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <DisclosureCard
      className={className ?? ""}
      title={title}
      titleId={titleId}
      headingLevel={3}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {children}
    </DisclosureCard>
  );
}

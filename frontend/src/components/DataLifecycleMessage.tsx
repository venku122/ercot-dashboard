import { dataLifecycleCopy, type DataLifecycleState } from "../dashboard/data-lifecycle";

type Props = {
  className?: string;
  detail?: string | undefined;
  state: Exclude<DataLifecycleState, "ready">;
  title?: string | undefined;
};

export function DataLifecycleMessage({ className = "", detail, state, title }: Props) {
  const copy = dataLifecycleCopy[state];
  return (
    <div
      className={`data-lifecycle-message ${className}`.trim()}
      data-lifecycle-state={state}
      role="status"
    >
      <strong>{title ?? copy.title}</strong>
      <p>{detail ?? copy.detail}</p>
    </div>
  );
}

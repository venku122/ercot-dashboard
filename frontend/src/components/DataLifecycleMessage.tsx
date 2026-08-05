import { dataLifecycleCopy, type DataLifecycleState } from "../dashboard/data-lifecycle";

type Props = {
  className?: string;
  detail?: string | undefined;
  state: Exclude<DataLifecycleState, "ready">;
};

export function DataLifecycleMessage({ className = "", detail, state }: Props) {
  const copy = dataLifecycleCopy[state];
  return (
    <div
      className={`data-lifecycle-message ${className}`.trim()}
      data-lifecycle-state={state}
      role="status"
    >
      <strong>{copy.title}</strong>
      <p>{detail ?? copy.detail}</p>
    </div>
  );
}

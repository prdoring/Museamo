import { Check } from "lucide-react";
import type { Entry } from "../data";

export function ChecklistToggle({ entry, pending, change }: {
  entry: Entry;
  pending: boolean;
  change: (entry: Entry) => void;
}) {
  const label = entry.text.trim().slice(0, 100) || "Photo/video post";
  return <button
    type="button"
    className="checklist-toggle"
    role="checkbox"
    aria-checked={entry.completed}
    aria-label={`Checklist item: ${label}`}
    aria-busy={pending}
    disabled={pending}
    onClick={() => change(entry)}
  ><span className="checklist-box" aria-hidden="true">{entry.completed && <Check size={16} />}</span></button>;
}

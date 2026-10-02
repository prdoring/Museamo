import { PaperIcon } from "./PaperIcon";
import {
  Hash,
  ListChecks,
  MoreHorizontal,
  Search,
} from "lucide-react";
import type { Tag } from "../data";
import { tagDisplayName } from "../data";
import { JoinSharedTag, SharedMark } from "./Sharing";
export function TagList({
  tags,
  query,
  open,
  edit,
  changed = async () => {},
}: {
  tags: Tag[];
  query: string;
  open: (id: string) => void;
  edit: (tag: Tag | "new") => void;
  changed?: () => Promise<void>;
}) {
  const filtered = tags.filter((t) =>
    t.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section aria-label="Tags">
      <button className="menu-row new-tag" onClick={() => edit("new")}>
        <PaperIcon name="plus" size={20} />
        New tag
      </button>
      <JoinSharedTag joined={changed} />
      {filtered.map((t) => (
        <div className="tag-row" key={t.id}>
          <button onClick={() => open(t.id)}>
            {t.type === "checklist" ? <ListChecks size={19} aria-hidden="true" /> : <Hash size={19} aria-hidden="true" />}
            <span>{tagDisplayName(t, tags)}{t.type === "checklist" && <small className="category-type">Checklist</small>}{t.sharing && <SharedMark />}</span>
            <small>{t.count || 0}</small>
            <PaperIcon name="next" size={18} />
          </button>
          <button
            className="icon-button"
            aria-label={`Edit ${t.name}`}
            onClick={() => edit(t)}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
      ))}
      {!filtered.length && (
        <p className="empty-state">
          {query
            ? "No matching tags. Try another name."
            : "Tags will appear here as you use them."}
        </p>
      )}
    </section>
  );
}
export function SearchField({
  tags,
  query,
  change,
}: {
  tags: boolean;
  query: string;
  change: (value: string) => void;
}) {
  return (
    <div className="search-box">
      <Search size={19} />
      <input
        autoFocus
        aria-label={tags ? "Search tags" : "Search thoughts"}
        placeholder={tags ? "Find a tag…" : "Find a thought…"}
        value={query}
        onChange={(e) => change(e.target.value)}
      />
      {query && (
        <button
          className="icon-button"
          aria-label="Clear search"
          onClick={() => change("")}
        >
          <PaperIcon name="close" size={18} />
        </button>
      )}
    </div>
  );
}

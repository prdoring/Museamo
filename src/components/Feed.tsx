import { PaperIcon } from "./PaperIcon";

import { dayLabel, type Entry, type Tag } from "../data";
import { Post } from "./Thoughts";
import { MotionList, type MotionItem } from "./Motion";
import type { FeedUpdate } from "../feedMotion";
export function Feed({
  entries,
  tags,
  checklist,
  categoryId,
  complete,
  pendingCompletions,
  loading,
  more,
  newThoughts,
  query,
  gems,
  todosOnly = false,
  reload,
  older,
  star,
  edit,
  remove,
  openTag,
  report,
  openLocation,
  scope = "feed", reason = "initial", beforeLayout,
}: {
  entries: Entry[];
  scope?: string; reason?: FeedUpdate; beforeLayout?: () => void;
  openLocation: (entry: Entry) => void;
  tags: Tag[];
  checklist: boolean;
  categoryId?: string;
  complete: (entry: Entry) => void;
  pendingCompletions: ReadonlySet<string>;
  loading: boolean;
  more: boolean;
  newThoughts: boolean;
  query: string;
  gems: boolean;
  todosOnly?: boolean;
  reload: () => void;
  older: () => void;
  star: (e: Entry) => void;
  edit: (e: Entry) => void;
  remove: (e: Entry) => void;
  openTag: (id: string) => void;
  report: (s: string) => void;
}) {
  const rows: MotionItem[] = [];
  entries.forEach((entry, i) => {
    const date = dayLabel(entry.createdAt), group = checklist ? `${entry.completed}/` : "";
    if (checklist && (i === 0 || entries[i - 1].completed !== entry.completed)) rows.push({ key: `group:${group}${date}`, content: (
      <div className="checklist-heading"><h2 className="checklist-section">{entry.completed ? "Checked" : "Unchecked"}</h2><span className="day-divider">{date}</span></div>
    ) });
    else if (i === 0 || dayLabel(entries[i - 1].createdAt) !== date) rows.push({ key: `date:${group}${date}`, content: <div className="day-divider">{date}</div> });
    rows.push({ key: entry.id, content: <Post entry={entry} openLocation={openLocation} tags={tags}
      checklistCategoryId={checklist ? categoryId : undefined} complete={complete} completionPending={pendingCompletions.has(entry.id)}
      star={() => star(entry)} edit={() => edit(entry)} remove={() => remove(entry)} openTag={openTag} report={report} /> });
  });
  return (
    <section className={"feed" + (checklist ? " checklist-feed" : "")} aria-label="Thoughts" aria-busy={loading}>
      {newThoughts && (
        <button className="new-thoughts" onClick={reload}>
          New thoughts <PaperIcon name="send" size={16} />
        </button>
      )}
      <MotionList items={rows} scope={scope} reason={reason} beforeLayout={beforeLayout} empty={loading && !entries.length ? (
        <p className="empty-state">Loading thoughts…</p>
      ) : (
        !entries.length && (
          <div className="empty-state">
            <PaperIcon name={gems ? "star" : "document"} size={48} />
            <h2>
              {query
                ? todosOnly ? "No matching to-dos" : "No matching thoughts"
                : todosOnly
                  ? "No to-do items yet."
                : gems
                  ? "Keep the good ones close."
                  : "No thoughts yet."}
            </h2>
            <p>
              {query
                ? "Try a different word or phrase."
                : todosOnly
                  ? "Turn on Checklist for a tag to see its thoughts here."
                : gems
                  ? "Star a thought to find it here."
                  : "Send yourself the first one."}
            </p>
          </div>
        )
      )} />
      {more && (
        <button className="load-more secondary" disabled={loading || (checklist && pendingCompletions.size > 0)} onClick={older}>
          {checklist ? "Load more thoughts" : "Load older thoughts"}
        </button>
      )}
    </section>
  );
}

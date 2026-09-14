import { PaperIcon } from "./PaperIcon";

import { dayLabel, type Entry, type Tag } from "../data";
import { Post } from "./Thoughts";
export function Feed({
  entries,
  tags,
  loading,
  more,
  newThoughts,
  query,
  gems,
  reload,
  older,
  star,
  edit,
  remove,
  openTag,
  report,
}: {
  entries: Entry[];
  tags: Tag[];
  loading: boolean;
  more: boolean;
  newThoughts: boolean;
  query: string;
  gems: boolean;
  reload: () => void;
  older: () => void;
  star: (e: Entry) => void;
  edit: (e: Entry) => void;
  remove: (e: Entry) => void;
  openTag: (id: string) => void;
  report: (s: string) => void;
}) {
  return (
    <section className="feed" aria-label="Thoughts" aria-busy={loading}>
      {newThoughts && (
        <button className="new-thoughts" onClick={reload}>
          New thoughts <PaperIcon name="send" size={16} />
        </button>
      )}
      {loading && !entries.length ? (
        <p className="empty-state">Loading thoughts…</p>
      ) : (
        !entries.length && (
          <div className="empty-state">
            <PaperIcon name={gems ? "star" : "document"} size={48} />
            <h2>
              {query
                ? "No matching thoughts"
                : gems
                  ? "Keep the good ones close."
                  : "No thoughts yet."}
            </h2>
            <p>
              {query
                ? "Try a different word or phrase."
                : gems
                  ? "Star a thought to find it here."
                  : "Send yourself the first one."}
            </p>
          </div>
        )
      )}
      {entries.map((entry, i) => (
        <div key={entry.id}>
          {(i === 0 ||
            dayLabel(entries[i - 1].createdAt) !==
              dayLabel(entry.createdAt)) && (
            <div className="day-divider">{dayLabel(entry.createdAt)}</div>
          )}
          <Post
            entry={entry}
            tags={tags}
            star={() => star(entry)}
            edit={() => edit(entry)}
            remove={() => remove(entry)}
            openTag={openTag}
            report={report}
          />
        </div>
      ))}
      {more && (
        <button className="load-more secondary" onClick={older}>
          Load older thoughts
        </button>
      )}
    </section>
  );
}

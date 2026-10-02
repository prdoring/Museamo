import { PaperIcon } from "./PaperIcon";
import { Hash, MapPin} from "lucide-react";
import { useDesktopLayout } from "./Desktop";
export type Tab = "stream" | "gems" | "tags" | "map";
export function Navigation({
  tab,
  settings,
  tagName,
  compose,
  navigate,
  openSettings,
}: {
  tab: Tab;
  settings?: boolean;
  tagName?: string;
  compose: () => void;
  navigate: (tab: Tab) => void;
  openSettings?: () => void;
}) {
  const desktop = useDesktopLayout();
  return (
    <footer className="bottom-dock">
      {(desktop || (!settings && (tab !== "tags" || !!tagName))) && (
        <button className="capture-bar" onClick={compose} title={tagName ? `Message #${tagName}…` : "Message yourself…"}>
          <PaperIcon name="plus" size={21} />
          <span>{tagName ? `Message #${tagName}…` : "Message yourself…"}</span>
          <span className="send-symbol">
            <PaperIcon name="send" size={21} />
          </span>
        </button>
      )}
      <nav aria-label="Main navigation">
        {(["stream", "gems", "tags", "map"] as Tab[]).map((next) => (
          <button
            key={next}
            aria-current={!settings && next === tab ? "page" : undefined}
            onClick={() => navigate(next)}
            title={next[0].toUpperCase() + next.slice(1)}
          >
            {next === "stream" ? (
              <PaperIcon name="document" size={21} />
            ) : next === "gems" ? (
              <PaperIcon name="star" size={21} />
            ) : (
              next === "map" ? <MapPin size={21} /> : <Hash size={21} />
            )}
            <span>{next[0].toUpperCase() + next.slice(1)}</span>
          </button>
        ))}
      </nav>
      {desktop && <button className="desktop-settings" onClick={openSettings} aria-current={settings ? "page" : undefined} title="Settings"><PaperIcon name="gear" size={21} /><span>Settings</span></button>}
    </footer>
  );
}

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formattedPaste, formatSelection } from "./formatting";
import { FormattedText } from "./components/FormattedText";
import fixtures from "../test-fixtures/formatting.json";
import { bridge, preview } from "./data";

describe("semantic paste", () => {
  for (const fixture of fixtures)
    it(fixture.name, () =>
      expect(formattedPaste(fixture.html)).toBe(fixture.markdown),
    );
});
it("preserves formatted drafts through failed sends, saves, edits and Undo", async () => {
  preview.reset(true);
  const text = "    indented\n\n**Word**\n\n- meaning\n- example";
  const { draft } = await bridge.getDraft({});
  await bridge.updateDraft({ ...draft, text });
  const savedDraft = (await bridge.getDraft({})).draft;
  expect(savedDraft.text).toBe(text);
  preview.failNext();
  expect(() => preview.save(savedDraft)).toThrow();
  expect((await bridge.getDraft({})).draft.text).toBe(text);
  const id = preview.save(savedDraft);
  expect((await bridge.getEntry({ id })).entry?.text).toBe(text);
  const changed = text + "\n\n> Keep noticing.";
  await bridge.updateEntry({ id, text: changed, tagIds: [] });
  const entry = (await bridge.getEntry({ id })).entry!;
  await bridge.deleteEntry({ id });
  await bridge.restoreEntry({ entry });
  expect((await bridge.getEntry({ id })).entry?.text).toBe(changed);
  preview.reset();
});
it("formats and toggles selected emphasis without losing surrounding text", () => {
  const bold = formatSelection("a good thought", 2, 6, "bold");
  expect(bold).toEqual({ text: "a **good** thought", start: 4, end: 8 });
  expect(formatSelection(bold.text, bold.start, bold.end, "bold").text).toBe(
    "a good thought",
  );
});
it("formats whole selected lines and does not include the next line", () => {
  expect(formatSelection("one\ntwo\nthree", 0, 8, "number").text).toBe(
    "1. one\n2. two\nthree",
  );
});
it("renders emphasis and lists and never loads images or executable links", () => {
  const html = renderToStaticMarkup(
    <FormattedText
      text={
        "**Word**\n\n- _meaning_\n- example\n\n[bad](javascript:alert) ![image](https://example.com/a.png)"
      }
    />,
  );
  expect(html).toContain("<strong>Word</strong>");
  expect(html).toContain("<ul>");
  expect(html).toContain("<em>meaning</em>");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
});
it("retains line breaks and auto-links plain URLs", () => {
  const html = renderToStaticMarkup(
    <FormattedText text={"one\ntwo https://example.com"} />,
  );
  expect(html).toContain("<br/>");
  expect(html).toContain('href="https://example.com/"');
});

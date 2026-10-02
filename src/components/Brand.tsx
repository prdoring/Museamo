import artwork from "../assets/branding/lantern.json";
import "../branding.css";

/** Filled geometry shared with the exported SVGs and native platform icons. */
export function Brand() {
  let x = 0;
  const letters = [...artwork.wordmark.letters].map((letter, index) => {
    const glyph = artwork.wordmark.glyphs[letter as keyof typeof artwork.wordmark.glyphs];
    const offset = x;
    x += glyph.width + (index < artwork.wordmark.letters.length - 1 ? artwork.wordmark.tracking : 0);
    return <path key={index} d={glyph.path} transform={`translate(${offset} 0)`} fillRule="evenodd" />;
  });
  return <span className="brand" role="img" aria-label="Museamo">
    <svg className="brand-mark" width={artwork.mark.width} height={artwork.mark.height} viewBox={`0 0 ${artwork.mark.width} ${artwork.mark.height}`} aria-hidden="true" focusable="false">
      <g fill="currentColor">{artwork.mark.frame.map((d, index) => <path key={index} d={d} />)}</g>
      <path className="brand-flame" d={artwork.mark.flame} fillRule="evenodd" />
    </svg>
    <svg className="brand-wordmark" width={x} height={artwork.wordmark.height} viewBox={`0 0 ${x} ${artwork.wordmark.height}`} fill="currentColor" aria-hidden="true" focusable="false">{letters}</svg>
  </span>;
}

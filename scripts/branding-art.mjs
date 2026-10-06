// Shared vector geometry for the web/native export tools. No fonts or network assets.
export function renderMark(art, ink = art.palette.cream, flame = art.palette.ochre) {
  return `<g fill="${ink}">${art.mark.frame.map(d => `<path d="${d}"/>`).join('')}</g><path fill="${flame}" fill-rule="evenodd" d="${art.mark.flame}"/>`;
}

export function renderIcon(art, rounded = false) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title desc"><title id="title">Museamo</title><desc id="desc">Carved lantern app icon; cream and ochre on navy.</desc><rect width="512" height="512"${rounded ? ' rx="88"' : ''} fill="${art.palette.navy}"/><g transform="translate(116.8 54.16) scale(.87)">${renderMark(art)}</g></svg>`;
}

export function renderLaunchMark(art, dark = false) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="128" viewBox="0 0 ${art.mark.width} ${art.mark.height}">${renderMark(art, dark ? art.palette.cream : art.palette.navy)}</svg>`;
}

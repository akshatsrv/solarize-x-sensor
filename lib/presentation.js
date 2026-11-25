export const presentationType = 'application/x-signage-presentation';
const themes = ['midnight', 'green', 'amber'];

export function presentationFrom(body, available) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 90 || !Array.isArray(body.slides) || body.slides.length < 1 || body.slides.length > 8) {
    throw new Error('Enter a presentation name and add 1–8 slides.');
  }
  const slides = body.slides.map(slide => {
    const headline = typeof slide?.headline === 'string' ? slide.headline.trim() : '';
    const message = typeof slide?.message === 'string' ? slide.message.trim() : '';
    const assetId = typeof slide?.assetId === 'string' ? slide.assetId : '';
    const asset = Object.hasOwn(available, assetId) && available[assetId];
    if (headline.length > 100 || message.length > 350 || (!headline && !message && !assetId) ||
        (assetId && !(asset && /^(image|video)\//.test(asset.type))) ||
        !themes.includes(slide?.theme) || !Number.isInteger(slide?.seconds) || slide.seconds < 2 || slide.seconds > 120) {
      throw new Error('Each slide needs content, an available image or video if selected, a theme, and 2–120 seconds.');
    }
    return { headline, message, assetId, theme: slide.theme, seconds: slide.seconds };
  });
  return { name, slides };
}

export function resolvePlaylist(state, ids) {
  return ids.flatMap(id => {
    const item = state.media[id];
    if (!item) return [];
    if (item.type !== presentationType) return [item];
    const assets = [...new Set(item.slides.map(slide => slide.assetId).filter(Boolean))]
      .map(asset => state.media[asset]).filter(Boolean);
    return [{ ...item, assets }];
  });
}

export function playlistFiles(items) {
  return items.flatMap(item => item.type === presentationType ? item.assets ?? [] : [item]);
}

export function displayItems(items) {
  return items.flatMap(item => {
    if (item.type !== presentationType) return [{ ...item, url: `/media/${item.id}` }];
    return item.slides.map((slide, index) => {
      const asset = item.assets.find(entry => entry.id === slide.assetId);
      return {
        id: item.id, name: `${item.name} · Slide ${index + 1}`, type: 'signage/slide',
        slide: { ...slide, asset: asset && { ...asset, url: `/media/${asset.id}` } },
      };
    });
  });
}

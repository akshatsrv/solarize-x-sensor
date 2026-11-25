export const presentationType = 'application/x-signage-presentation';

export function buildSlide(slide, { muted = true, preview = false } = {}) {
  const panel = document.createElement('article');
  panel.className = 'signage-slide';
  panel.dataset.theme = slide.theme;
  const copy = document.createElement('div');
  copy.className = 'slide-copy';
  const heading = document.createElement('h1');
  heading.textContent = slide.headline;
  const message = document.createElement('p');
  message.textContent = slide.message;
  if (slide.headline) copy.append(heading);
  if (slide.message) copy.append(message);
  if (copy.childNodes.length) panel.append(copy);

  let visual;
  if (slide.asset) {
    const video = slide.asset.type.startsWith('video/');
    visual = document.createElement(video ? 'video' : 'img');
    visual.alt = '';
    if (video) {
      visual.muted = muted;
      visual.playsInline = true;
      visual.autoplay = !preview;
      visual.loop = !preview;
      visual.controls = preview;
      visual.preload = 'metadata';
    }
    panel.dataset.layout = copy.childNodes.length ? 'split' : 'media';
    panel.append(visual);
  }
  return { panel, visual };
}

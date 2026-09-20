/* checkto panel directions d5–d9 — comp harness.
 *
 * Two jobs, both small:
 *   1. forms are real <form> elements (so the markup matches the shipped
 *      panel) but a comp must never navigate: submit is cancelled.
 *   2. ?probe gives an automated geometry check. Open dX.html?probe and a
 *      <pre id="probe-out"> is appended reporting, per frame, whether anything
 *      overflows horizontally or clips vertically. Used to verify the 320px
 *      requirement without trusting a screenshot alone.
 */

document.addEventListener('submit', (event) => event.preventDefault(), true);

if (location.search.includes('probe')) {
  addEventListener('load', () => {
    const lines = [];
    const doc = document.documentElement;
    lines.push(`document: client=${doc.clientWidth} scroll=${doc.scrollWidth} overflow=${doc.scrollWidth - doc.clientWidth}`);

    document.querySelectorAll('.panel-frame').forEach((frame, index) => {
      const state = frame.closest('.frame-slot')?.dataset.state ?? '?';
      const content = frame.querySelector('.content');
      lines.push(
        `frame ${index + 1} (${state} / ${frame.clientWidth}px): ` +
          `h-overflow=${frame.scrollWidth - frame.clientWidth} ` +
          `content-h-overflow=${content ? content.scrollWidth - content.clientWidth : 'n/a'} ` +
          `content-clipped=${content ? content.scrollHeight - content.clientHeight : 'n/a'}`
      );
      frame.querySelectorAll('*').forEach((node) => {
        if (node.classList.contains('sr-only')) return;
        const over = node.scrollWidth - node.clientWidth;
        if (over > 0 && node.clientWidth > 0) {
          lines.push(`  ! ${state} ${node.tagName.toLowerCase()}.${node.className || '(no class)'} h-overflow=${over}`);
        }
      });
    });

    const pre = document.createElement('pre');
    pre.id = 'probe-out';
    pre.textContent = lines.join('\n');
    pre.style.cssText = 'position:absolute;left:0;top:0;color:#fff;background:#000;font:11px monospace;padding:8px;white-space:pre-wrap;z-index:99';
    document.body.appendChild(pre);
  });
}

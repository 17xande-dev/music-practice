// The play/pause button: one button with both icons, showing one by its
// data-state (styles.css), with its label and accessible name to match.

export function setPlaying(button: HTMLElement, playing: boolean, labels = ["Start", "Stop"]) {
  const text = playing ? labels[1] : labels[0];
  button.dataset.state = playing ? "playing" : "stopped";
  const label = button.querySelector(".label");
  if (label) label.textContent = text;
  else button.textContent = text;
  button.setAttribute("aria-label", text);
}

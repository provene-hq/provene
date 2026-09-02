/**
 * Two files, not one recolourable file.
 *
 * An SVG loaded through <img> is a separate document: it cannot see
 * `currentColor` or any custom property from the page around it. Inlining the
 * markup instead would put ~35 KB of traced path data into the JS bundle and
 * still leave the static pages -- which this bundle does not build -- without
 * a mark. So the two tones ship as two files, and both are usable from plain
 * HTML.
 *
 * The dark variant carries the lattice; the light one does not, because the
 * lattice was drawn to read against navy and muddies a white header.
 */
const SRC = {
  dark: "/provene-mark.svg",
  light: "/provene-mark-light.svg",
} as const;

export function Mark({ size, tone }: { size: number; tone: keyof typeof SRC }) {
  return (
    <img
      src={SRC[tone]}
      alt=""
      aria-hidden="true"
      width={size}
      height={Math.round((size * 1650) / 1560)}
    />
  );
}

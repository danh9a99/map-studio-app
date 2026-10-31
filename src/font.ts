import { loadFont } from "@remotion/google-fonts/BeVietnamPro";

/** The typeface of every label, name and title on the footage. */
export const FONT = loadFont("normal", { weights: ["600", "800", "900"], subsets: ["vietnamese", "latin"] }).fontFamily;

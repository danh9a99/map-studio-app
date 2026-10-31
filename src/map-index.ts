// Entry of the desktop map app's render bundle: only the MapShot composition, so the bundle stays small.
import { registerRoot } from "remotion";
import { MapRoot } from "./MapRoot";

registerRoot(MapRoot);

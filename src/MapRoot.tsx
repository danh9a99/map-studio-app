import { Composition, staticFile } from "remotion";
import { MapShot, docFrames, outSize, type MapDoc } from "./mapshot/MapShot";

/** The map on aerial footage (the render bundle's only composition). */
export const MapRoot: React.FC = () => (
  <Composition
    id="MapShot"
    component={MapShot}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={180}
    defaultProps={{ map: "map-test/map.json" } as { map: string; doc?: MapDoc }}
    calculateMetadata={async ({ props }) => {
      const p = props as { map: string; doc?: MapDoc };
      const doc: MapDoc = p.doc ?? ((await fetch(staticFile(p.map)).then((r) => r.json())) as MapDoc);
      const { W, H } = outSize(doc.aspect);
      return { durationInFrames: docFrames(doc), fps: doc.fps, width: W, height: H, props: { ...p, doc } };
    }}
  />
);

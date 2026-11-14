// 12 · TINY ISLAND — a low-poly diorama turning on a golden-hour turntable.
//
// Everything is a primitive with few sides (that's the low-poly look: 7-sided
// cones, ico spheres at subdivision 1) and a matte clay material. The island
// is one group spun by an expression: 40°/s over 9 s is exactly one turn, so
// the loop is seamless. It floats: a sine on z, and a soft shadow far below.

const DUR = 9000;
const SKY = "#F3DDBA";

return {
  meta: {
    no: "12", family: "3D world", name: "Tiny Island",
    line: "A low-poly floating island with a house and trees, turning once on a golden-hour turntable.",
    prompt: "A low-poly floating island in a 3D world at golden hour: a 7-sided rock cone, a grass cap, a little ivory house with a clay roof, two round trees, a few rocks and puffy clouds. Matte clay materials, warm sun from the side, soft bloom and ambient occlusion, a faint shadow far below. The island bobs and turns exactly once in 9 s, so it loops. No water.",
    remix: ["Turn it into a winter island: snow cap, pine cones, a blue hour sky.", "Put your logo on the house as an extruded sign.", "Swap the turntable for a slow camera dolly that ends on the door."],
    tech: "primitives with low vertex counts · clay materials · group spun by expression · sun + hemisphere light · bloom, AO, shadow floor",
    heavy: true,
  },
  w: 1080, h: 1080, dur: DUR, bg: SKY, world: true,
  async build(f) {
    const add = (o) => ac.world.add({ frameId: f.id, startMs: 0, durationMs: DUR, ...o });
    const mesh = async (name, primitive, params, position, color, extra = {}) => {
      const r = await add({ kind: "mesh", name, primitive, params, position, color, material: "clay", ...extra });
      return r.id;
    };
    const parts = [];
    parts.push(await mesh("Rock", "cone", { radius1: 30, radius2: 300, depth: 300, vertices: 7 }, [0, 0, -150], "#8C6F5B"));
    parts.push(await mesh("Grass", "cylinder", { radius: 312, depth: 34, vertices: 7 }, [0, 0, 14], "#8FB36A"));
    parts.push(await mesh("House", "cube", { sizeX: 120, sizeY: 110, sizeZ: 96 }, [70, 20, 79], "#F4ECDF"));
    parts.push(await mesh("Roof", "pyramid", { base: 175, height: 84, sides: 4 }, [70, 20, 168], "#D97757", { rotation: [0, 0, 45] }));
    parts.push(await mesh("Door", "cube", { sizeX: 34, sizeY: 6, sizeZ: 56 }, [70, -38, 59], "#5A4636"));
    parts.push(await mesh("Window", "cube", { sizeX: 6, sizeY: 30, sizeZ: 30 }, [132, 20, 96], "#E8B866"));
    for (const [n, x, y, h, r, c] of [["Tree", -150, -40, 120, 74, "#6E9150"], ["Tree small", -60, 150, 80, 50, "#86A85C"], ["Tree back", 170, 170, 70, 46, "#6E9150"]]) {
      parts.push(await mesh(`${n} trunk`, "cylinder", { radius: 12, depth: h, vertices: 6 }, [x, y, 31 + h / 2], "#8A6440"));
      parts.push(await mesh(n, "icoSphere", { radius: r, subdivisions: 1 }, [x, y, 31 + h + r * 0.6], c));
    }
    for (const [x, y, r] of [[-200, 140, 26], [210, -120, 34], [-30, -200, 20]]) parts.push(await mesh("Rock small", "icoSphere", { radius: r, subdivisions: 0 }, [x, y, 31 + r * 0.4], "#A9978A"));
    const g = await ac.layers.group({ ids: parts, name: "Island" });
    const island = g.id ?? g.groupId;
    await ac.expression.set({ id: island, property: "rotation", source: "#time * 40" });
    await ac.expression.set({ id: island, property: "z", source: "sin(#time * 0.698) * 14" });

    // Clouds drift around it, not with it.
    for (const [i, [x, y, z, s]] of [[-380, 120, 220, 1], [360, -80, 300, 0.8], [260, 260, 60, 0.6]].entries()) {
      const ids = [];
      for (const [dx, r] of [[-40, 40], [0, 54], [44, 38]]) ids.push(await mesh(`Cloud ${i + 1}`, "icoSphere", { radius: r * s, subdivisions: 1 }, [x + dx * s, y, z], "#FFFFFF", { material: "matte" }));
      const cg = await ac.layers.group({ ids, name: `Cloud ${i + 1}` });
      await ac.expression.set({ id: cg.id ?? cg.groupId, property: "x", source: `sin(#time * 0.698 + ${i * 2}) * 30` });
    }

    // Light, camera, look.
    await add({ kind: "light", light: "sun", name: "Sun", position: [-600, -500, 700], lookAt: [0, 0, 0], color: "#FFD9A6", intensity: 2.6 });
    await add({ kind: "light", light: "hemisphere", name: "Sky fill", color: "#CFE0F2", intensity: 0.9 });
    const cam = await add({ kind: "camera", name: "Camera", position: [0, -1450, 660], lookAt: [0, 0, 30], focalLength: 50 });
    await ac.world.camera({ frameId: f.id, activate: cam.id });
    await ac.world.look({ frameId: f.id, toneMapping: "agx", shadows: true, bloom: { enabled: true, strength: 0.35, threshold: 0.8 }, ao: { enabled: true, strength: 1 }, floor: { mode: "shadow", opacity: 0.18, z: -420 } });
  },
};

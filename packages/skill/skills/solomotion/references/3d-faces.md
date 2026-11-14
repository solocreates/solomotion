# 3D faces that talk

A 3D face talks through its **shape keys** (blendshapes / morph targets) and two **pose sets** on its character group: a Mouth set in the `visemes` vocabulary and an Eyes set. Lip sync drives the Mouth set; PoseMix eases between mouth shapes. Read `shape-keys.md`, `poses.md` and `lip-sync.md` for those pieces; this page is the 3D path through them.

## Make one talk

```
world_import_model {attachmentId, frameId?, position?}   → .glb/.gltf avatar: blendshapes become shape keys, the face gets Mouth + Eyes sets
world_add {frameId, kind: "head"}                        → a built-in stylised head (no file needed) with visemes + blinks
world_face {id}                                          → build / rebuild Mouth + Eyes sets for a mesh that already has keys
speech_bind {target: <groupId>, voice: "Voice"}          → only that voice (a face already hears every voice)
```

- `world_face {id, dryRun: true}` reports what it recognised — `convention`, `missing` visemes, eye poses — without writing.
- The sets live on the mesh's **group** (made around it if it has none). Re-running `world_face` rebuilds the sets in place: set ids, pose keys and the Lip sync behavior survive.
- Blink: drive the Eyes set — `expression_set(groupId, "pose.<eyesSetId>", 'if(blink(4) > 0, "Closed", #value)')`, or `poses_key` Open/Closed. The head's `eyeBlink_L` / `eyeBlink_R` keys wink one eye.
- Emphasis: `loudness("Voice")` on `key.jawOpen` (an ARKit avatar or the head) opens the jaw with the volume, on top of the visemes.

## What is recognised

Names match loosely — case, `_ - . :`, spaces, exporter prefixes (`blendShape1.`, `BS_`, `ARKit_`) and Left/Right vs `_L`/`_R` are ignored, so `jawOpen`, `JawOpen`, `jaw_open` are one key.

| Convention | Typical source | Mouth from |
|---|---|---|
| `oculus` | Ready Player Me, VRChat (`viseme_aa`, `vrc.v_aa`) | one viseme key each — wins when a face also has ARKit |
| `arkit` | ARKit-52 heads, MetaHuman exports (`jawOpen`, `mouthFunnel`…) | a weighted mix per viseme |
| `vrm` | VRoid (`Fcl_MTH_A`…), VRM `A I U E O` | vowels, consonants borrow the nearest |
| `visemes` | the built-in head, hand-made keys named `AI E O U MBP FV L S` | one key each |

A face with none of these (`world_face` refuses with its key names): build the sets yourself with `poses_create`, values `{clipId: mesh, path: "key.<id>", value}`.

## Imported models

- An imported model's keys are **asset** keys: the offsets stay in the file, only weights live in the project. One key drives every mesh in the model with a target of that name (head, teeth, eyes).
- `shapekey_inspect {id}` lists them; `layer_set {id, "key.<id>": 0.7}` / `keyframes_set` key them like any value.
- Export (3D model, glTF/GLB) writes keys as morph targets with their names, and with motion baked, keyed weights as a weights animation — other tools receive blendshapes they can drive.

## Check your work

`view_render` the world at a few times across a line: an open vowel should show the inside of the mouth; `MBP` closed lips. If the mouth never moves, `poses_inspect {groupId}` shows whether the Mouth set has a driver.

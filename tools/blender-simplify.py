# tools/blender-simplify.py — run by tools/build-landmarks.mjs through Blender (headless):
#   blender -b --factory-startup -P tools/blender-simplify.py -- <in.glb> <out.glb> <voxel m> <planar degrees>
# Dissolves a landmark's heightfield solid (tools/build-landmarks.mjs) into large flat faces (planar decimation): its
# roofs, walls, towers and spire as clean planes; then fewer triangles still, and triangulated.
import sys
import bpy
import bmesh

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst, voxel, planar = argv[0], argv[1], float(argv[2]), float(argv[3])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

def apply(mod):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)

# (the input is already a closed heightfield solid: tools/build-landmarks.mjs; weld its duplicate vertices first)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.01)
bpy.ops.object.mode_set(mode='OBJECT')
# 3. large flat faces
m = obj.modifiers.new('planar', 'DECIMATE')
m.decimate_type = 'DISSOLVE'
m.angle_limit = planar * 3.14159265 / 180
apply(m)
# 4. then fewer triangles still where the planes are tiny
m = obj.modifiers.new('collapse', 'DECIMATE')
m.decimate_type = 'COLLAPSE'
m.ratio = 0.35
apply(m)
m = obj.modifiers.new('tri', 'TRIANGULATE')
apply(m)

obj.data.materials.clear()
print('[blender] faces', len(obj.data.polygons))
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', use_selection=False, export_materials='NONE',
                          export_normals=False, export_texcoords=False, export_yup=True)

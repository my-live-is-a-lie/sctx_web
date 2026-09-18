from lib.glTF import glTF
from lib.odin import SupercellOdinGLTF


def convert_supercell_glb(data):
    source = glTF()
    source.read(bytes(data))
    for chunk in source.chunks:
        chunk.deserialize_json()
    converted = SupercellOdinGLTF(source).process()
    return converted.write()

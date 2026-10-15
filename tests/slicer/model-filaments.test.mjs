import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { highestModelFilamentSlot, paintStates } from '../../dist/slicer/model-filaments.js';

test('paint data decodes leaf states like TriangleSelector::deserialize', () => {
  // One unsplit triangle: state in bits 2-3.
  assert.deepEqual(paintStates('4'), [1]);
  assert.deepEqual(paintStates('8'), [2]);
  // Extended state: 0b1100, then the next nibble holds state - 3 (read from the end of the string).
  assert.deepEqual(paintStates('1C'), [4]);
  // 0xF nibbles add 15 each: 3 + 15 + 2 = 20.
  assert.deepEqual(paintStates('2FC'), [20]);
  // A triangle split on one side has two children, read after the parent.
  assert.deepEqual(paintStates('841'), [1, 2]);
});

test('the highest slot comes from parts, objects and paint', async () => {
  const zip = new JSZip();
  zip.file('Metadata/model_settings.config', '<config><object id="1"><metadata key="extruder" value="1"/><part id="2"><metadata key="extruder" value="2"/></part></object></config>');
  assert.equal(await highestModelFilamentSlot(zip), 2);
  zip.file('3D/Objects/object_1.model', '<model><mesh><triangles><triangle v1="0" v2="1" v3="2" paint_color="1C"/></triangles></mesh></model>');
  assert.equal(await highestModelFilamentSlot(zip), 4);
  assert.equal(await highestModelFilamentSlot(new JSZip()), 0);
});

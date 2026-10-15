import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { BambuImplementation } from '../../dist/printers/bambu.js';

// A raw MQTT transport boundary; never contacts hardware.
test('safety status uses fresh printer report, not configured serial model', async () => {
  const printer = new EventEmitter();
  printer.data = { model: 'H2D', gcode_state: 'IDLE' };
  printer.publish = async payload => {
    if (payload.pushing) queueMicrotask(() => printer.emit('rawMessage', 'device/01PTEST/report', Buffer.from(JSON.stringify({print: {command:'push_status', model_id:'C12', gcode_state:'IDLE', print_error:0, hms:[], nozzle_diameter:'0.4'}}))));
  };
  const impl = new BambuImplementation();
  impl.getPrinter = async () => printer;
  const status = await impl.getSafetyStatus('mock', '01PTEST', 'fake');
  assert.equal(status.model, 'p1s');
  assert.equal(status.observation.source, 'mqtt');
  assert.ok(status.observation.receivedAt >= status.observation.requestedAt);
});

const safety = await import('../../dist/safety/printer-state.js');
const fresh = (raw = {}, extra = {}) => ({
  connected: true, model: 'P1S', serial: '01PTEST', status:'IDLE',
  raw: { model_id:'C12', gcode_state:'IDLE', print_error:0, hms:[], nozzle_diameter:'0.4', nozzle_type:'hardened_steel', ...raw },
  observation:{source:'mqtt',requestedAt:Date.now(),receivedAt:Date.now(),identitySource:'report'}, ...extra,
});
const req = (extra = {}) => ({model:'P1S',nozzleDiameters:[0.4],materials:['PLA'],useAMS:false,...extra});
const check = (status, requirements=req()) => safety.validatePrinterState(status, requirements);
const rawPrinter = (publish) => {
  const printer = new EventEmitter();
  printer.data = {model:'P1S',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:'0.4'};
  printer.publish = async payload => publish(payload, (message, topic='device/01PTEST/report') => printer.emit('rawMessage',topic,Buffer.from(JSON.stringify(message))), printer);
  return printer;
};

test('accepts observed model aliases and a manually declared external material', () => {
  assert.doesNotThrow(() => check(fresh()));
  assert.doesNotThrow(() => check(fresh({model_id:undefined,model:'Bambu Lab A1 mini'}), req({model:'a1mini'})));
  assert.doesNotThrow(() => check(fresh({model_id:undefined,model:'H2D Pro'}), req({model:'h2dpro',nozzleDiameters:[]})));
});
test('ignores a print-job id in model_id when model or returned serial identifies X2D', () => {
  const requirements = req({model:'x2d',nozzleDiameters:[],verifyMaterials:false});
  assert.doesNotThrow(() => check(fresh({model_id:'USb5974ce12ab89d',model:'X2D'}), requirements));
  assert.doesNotThrow(() => check(fresh({model_id:'USb5974ce12ab89d',modules:[{name:'ota',sn:'20PTEST'}]}, {serial:'20PTEST'}), requirements));
  assert.throws(() => check(fresh({model_id:'N6',model:'P1S'}), requirements), /contradictory/i);
  assert.throws(() => check(fresh({model_id:undefined,model:'P1S',modules:[{name:'ota',sn:'20PTEST'}]}, {serial:'20PTEST'}), requirements), /contradictory/i);
  assert.throws(() => check(fresh({model_id:'USb5974ce12ab89d',model:'X2D',printer_type:'unknown'}), requirements), /unknown model identity/i);
});
test('rejects missing, stale, future and synthetic telemetry provenance', () => {
  for(const observation of [undefined,{source:'configured',requestedAt:Date.now(),receivedAt:Date.now()}, {source:'mqtt',requestedAt:1,receivedAt:2}, {source:'mqtt',requestedAt:Date.now()+5000,receivedAt:Date.now()+5000}, {source:'mqtt',requestedAt:Date.now(),receivedAt:Date.now()-1}]) {
    assert.throws(() => check(fresh({}, {observation})), /fresh|observ|mqtt|stale/i);
  }
  assert.throws(() => check(fresh({}, {connected:false})), /connect/i);
});
test('configured model or configured serial does not establish observed printer identity', () => {
  assert.throws(() => check(fresh({model_id:undefined}, {model:'P1S'})), /identity|model/i);
  assert.throws(() => check(fresh({model_id:'N2S'})), /model/i);
  assert.throws(() => check(fresh({model_id:'UNRECOGNIZED'})), /identity|model/i);
  assert.throws(() => check(fresh({model_id:undefined,modules:[{name:'ams',sn:'01PTEST'}]})), /identity|model/i);
});
test('a returned ota serial is identity evidence but must match configured printer serial', () => {
  assert.doesNotThrow(() => check(fresh({model_id:undefined,modules:[{name:'ota',sn:'01PTEST'}]})));
  assert.throws(() => check(fresh({modules:[{name:'ota',sn:'01POTHER'}]})), /serial/i);
  assert.throws(() => check(fresh({modules:[{name:'ota',sn:'094OTHER'}]})), /serial|model|identity/i);
});
test('diameter must be reported and match; bed-only state reads may omit diameter', () => {
  for(const nozzle_diameter of [undefined,'unknown',0,'NaN',0.6]) assert.throws(() => check(fresh({nozzle_diameter})), /nozzle|diameter/i);
  assert.doesNotThrow(() => check(fresh({nozzle_diameter:undefined}),req({nozzleDiameters:[]})));
});
test('matches used nozzles by index rather than accepting one matching nozzle among multiple', () => {
  // Report: id 0 is the right (main) nozzle, id 1 the left (deputy). Sliced files list the left nozzle first.
  const status = fresh({model_id:'O1D',nozzle_diameter:undefined,device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.6,type:'HS01',stat:0}]}}});
  assert.doesNotThrow(() => check(status,req({model:'h2d',nozzleDiameters:[0.6,0.4]})));
  // The mirror-image job (left 0.4, right 0.6) must not pass on this printer.
  assert.throws(() => check(status,req({model:'h2d',nozzleDiameters:[0.4,0.6]})), /nozzle 1 diameter/i);
  assert.throws(() => check(status,req({model:'h2d',nozzleDiameters:[0.4,0.4]})), /nozzle|diameter/i);
  assert.throws(() => check(status,req({model:'h2d',nozzleDiameters:[0.4]})), /nozzle|ambiguous/i);
  assert.doesNotThrow(() => check(status,req({model:'h2d',nozzleDiameters:[0.6],usedNozzleIndices:[1],nozzleFlows:['Standard']})));
  assert.throws(() => check(status,req({model:'h2d',nozzleDiameters:[0.6],usedNozzleIndices:[1],nozzleFlows:['High Flow']})), /flow/i);
});
test('nozzle material only feeds a hardness warning; flow and abnormal nozzles block, like Bambu Studio', () => {
  // Studio compares diameter and flow (CheckErrorExtruderNozzleWithSlicing): a stock hardened-steel preset prints on a
  // stainless nozzle, with a warning only when the filament is harder than the nozzle.
  assert.deepEqual(check(fresh({nozzle_type:'stainless_steel'}),req({nozzleTypes:['hardened_steel']})).hmsWarnings, []);
  assert.match(check(fresh({nozzle_type:'stainless_steel'}),req({nozzleTypes:['hardened_steel'],filamentTypes:['PLA-CF']})).hmsWarnings.join(), /PLA-CF is harder than nozzle 0 \(stainless steel\)/);
  assert.deepEqual(check(fresh({nozzle_type:'hardened_steel'}),req({filamentTypes:['PLA-CF']})).hmsWarnings, []);
  assert.throws(() => check(fresh({nozzle_type:'HH01'}),req({nozzleFlows:['Standard']})), /flow/i);
  // stat bit 0 is "unreliable" (a warning in Studio); bits 1-2 abnormal or unknown, which block a used nozzle.
  assert.match(check(fresh({device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:1}]}}})).hmsWarnings.join(), /nozzle 0 information is unreliable/);
  for(const stat of [2,4]) assert.throws(() => check(fresh({device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat}]}}})), /abnormal or unknown/i);
});
test('rejects busy, failed, missing or unknown states while allowing IDLE and FINISH', () => {
  for(const gcode_state of ['RUNNING','PAUSE','PREPARE','SLICING','OFFLINE','UNKNOWN',undefined]) assert.throws(() => check(fresh({gcode_state})), /state|idle/i);
  // A stopped or failed job leaves the printer idle (FAILED), ready for a new job like FINISH.
  for(const gcode_state of ['IDLE','FINISH','FAILED']) assert.doesNotThrow(() => check(fresh({gcode_state})), gcode_state);
  assert.doesNotThrow(() => check(fresh({gcode_state:'FINISH'})));
});
test('requires explicit clean print error and valid HMS severity, but permits informative HMS', () => {
  for(const print_error of [undefined,1,'03008004','not-a-number']) assert.throws(() => check(fresh({print_error})), /error/i);
  // Fatal, unknown-severity and malformed entries block; serious and common ones come back as warnings.
  for(const hms of [undefined,'bad',[{attr:0,code:0x10001}],[{attr:0,code:0x50001}],[{attr:0,code:0x00001}],[{attr:0}],[{severity:'info',code:0x10001}]]) assert.throws(() => check(fresh({hms})), /HMS/i);
  assert.doesNotThrow(() => check(fresh({hms:[{attr:0x03000100,code:0x40001}]})));
  assert.deepEqual(check(fresh({hms:[{attr:0x0C000100,code:0x0002001B},{attr:0x03000100,code:0x30001},{attr:0x03000100,code:0x40001}]})).hmsWarnings,
    ['HMS 0C00-0100-0002-001B (serious)','HMS 0300-0100-0003-0001 (common)']);
  // 0500-0500-0001-0007 is a refused unsigned command, not a printer fault: a warning. Other fatal codes still block.
  assert.deepEqual(check(fresh({hms:[{attr:0x05000500,code:0x00010007}]})).hmsWarnings, ['HMS 0500-0500-0001-0007 (a refused unsigned command, not a printer fault)']);
  assert.throws(() => check(fresh({hms:[{attr:0x05000500,code:0x00010008}]})), /fatal HMS error \(HMS 0500-0500-0001-0008\)/);
});
test('known maintenance reminders do not block, but faults beside them and unknown codes in their family do', () => {
  // H2C report: threaded rods and X/YZ/extruder-lift rails need lubrication (0501-0400-0003-0002/0004).
  const reminders=[{attr:0x05010400,code:0x00030002},{attr:0x05010400,code:0x00030004}];
  assert.doesNotThrow(() => check(fresh({hms:reminders})));
  for(const code of [0x00030003,0x00030005,0x00030006,0x00030007,0x00030010]) assert.doesNotThrow(() => check(fresh({hms:[{attr:0x05010400,code}]})));
  assert.throws(() => check(fresh({hms:[...reminders,{attr:0x0C000100,code:0x00010001}]})), /HMS 0C00-0100-0001-0001/);
  // Codes outside the known reminder list keep their own severity: fatal blocks, common is only a warning.
  assert.throws(() => check(fresh({hms:[{attr:0x05010400,code:0x00010044}]})), /fatal HMS/i);
  for(const [attr,code] of [[0x05010400,0x00030008],[0x05010401,0x00030002],[0x05000400,0x00030002]])
    assert.deepEqual(check(fresh({hms:[{attr,code}]})).hmsWarnings.map(w=>w.endsWith('(common)')), [true]);
  assert.deepEqual(check(fresh({hms:reminders})).hmsWarnings, ['HMS 0501-0400-0003-0002 (maintenance reminder)','HMS 0501-0400-0003-0004 (maintenance reminder)']);
  assert.throws(() => check(fresh({print_error:1,hms:reminders})), /error/i);
  // A canceled task (0300-400C) stays reported until the next job; it is a warning, other print errors block.
  assert.deepEqual(check(fresh({gcode_state:'FAILED',print_error:0x0300400C})).hmsWarnings, ['print_error 0300-400C (the previous task was canceled)']);
  // Every stop-class code (xxxx-4xxx) is the record of a stopped task, e.g. 0500-400E "Job was cancelled.".
  assert.deepEqual(check(fresh({gcode_state:'FAILED',print_error:0x0500400E})).hmsWarnings, ['print_error 0500-400E (the previous task stopped)']);
  // Pause (8xxx) and prompt (Cxxx) classes wait for an action and still block.
  for(const print_error of [0x0300800A,0x07FF8012,0x0500C011]) assert.throws(() => check(fresh({gcode_state:'IDLE',print_error})), /print error \(/);
  // A paused job's stop-class code is not waved through on resume.
  assert.throws(() => check(fresh({gcode_state:'PAUSE',print_error:0x0500400E}),req({requireIdle:false})), /print error/);
});
const ams = {ams:[{id:'0',tray:[{id:'0',tray_type:'PLA',nozzle_temp_min:'190',nozzle_temp_max:'240'},{id:'1',tray_type:'PETG',nozzle_temp_min:'220',nozzle_temp_max:'270'}]}]};
test('AMS requirements use positional mappings and selected slot material, including external 254', () => {
  assert.doesNotThrow(() => check(fresh({ams}),req({materials:['PLA','PETG'],useAMS:true,amsMapping:[0,1],usedFilamentPositions:[1]})));
  assert.throws(() => check(fresh({ams}),req({useAMS:true,amsMapping:[1]})), /material|PETG/i);
  assert.throws(() => check(fresh({ams}),req({useAMS:true,amsMapping:[2]})), /slot|tray|AMS/i);
  assert.throws(() => check(fresh({ams}),req({useAMS:true,amsMapping:[]})), /mapping/i);
  assert.doesNotThrow(() => check(fresh({ams}),req({useAMS:true,amsMapping:[254]})));
});
test('manual non-RFID spool declaration is allowed but reported material contradictions reject', () => {
  assert.doesNotThrow(() => check(fresh({ams:{ams:[{id:'0',tray:[{id:'0'}]}]}}),req({useAMS:true,amsMapping:[0]})));
  assert.throws(() => check(fresh({vt_tray:{id:'254',tray_type:'PETG'}})), /material/i);
  assert.throws(() => check(fresh(),req({materials:[]})), /material/i);
  assert.throws(() => check(fresh({ams:{...ams,tray_exist_bits:'2'}}),req({useAMS:true,amsMapping:[0]})), /empty|present|slot/i);
});
test('reported spool temperature ranges constrain results and malformed ranges reject', () => {
  const result = check(fresh({ams}),req({useAMS:true,amsMapping:[0]}));
  assert.equal(result.filaments[0].nozzleMax,240);
  assert.throws(() => check(fresh({vt_tray:{tray_type:'PLA',nozzle_temp_min:'280',nozzle_temp_max:'200'}})), /temperature|range/i);
});
test('fresh read ignores cache, pre-request events, acknowledgements and other device topics', async () => {
  const printer = rawPrinter((_payload, emit) => { emit({print:{command:'push_status',gcode_state:'IDLE',model_id:'C12',print_error:0,hms:[]}},'device/OTHER/report'); emit({print:{command:'push_status',sequence_id:'1'}}); });
  await assert.rejects(safety.readFreshPrinterStatus(printer,'01PTEST',20),/fresh|timed out/i);
  // Only the per-client report tracker (printer-report.ts) stays attached; the read's own listener is gone.
  assert.equal(printer.listenerCount('rawMessage'),1);
});
test('fresh read obtains missing model from current get_version ota response', async () => {
  const printer = rawPrinter((payload, emit) => {
    if(payload.pushing) emit({print:{command:'push_status',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:'0.4'}});
    if(payload.info) emit({info:{command:'get_version',module:[{name:'ota',sn:'01PTEST'}]}});
  });
  const status = await safety.readFreshPrinterStatus(printer,'01PTEST',50);
  assert.equal(status.model,'p1s'); assert.equal(status.observedSerial,'01PTEST');
  assert.equal(status.observation.identitySource,'module-serial');
  assert.doesNotThrow(() => check(status));
  assert.equal(printer.listenerCount('rawMessage'),1);
});
test('fresh read fails on disconnect or publish failure, and bounds hung request', async () => {
  const disconnected = rawPrinter((_payload,_emit,p) => p.emit('client:disconnect'));
  await assert.rejects(safety.readFreshPrinterStatus(disconnected,'01PTEST',20),/disconnect/i);
  const failed = rawPrinter(() => { throw Error('publish failed'); });
  await assert.rejects(safety.readFreshPrinterStatus(failed,'01PTEST',20),/publish failed/);
  const hung = rawPrinter(() => new Promise(() => {}));
  await assert.rejects(safety.readFreshPrinterStatus(hung,'01PTEST',20),/fresh|timed out/i);
});

test('AMS HT slot128 is addressed as unit128 slot0, preserving its material check', () => {
  const reported = {ams:[{id:'128',tray:[{id:'0',tray_type:'PLA'}]}]};
  assert.doesNotThrow(() => check(fresh({ams:reported}),req({useAMS:true,amsMapping:[128]})));
  assert.throws(() => check(fresh({ams:reported}),req({materials:['PETG'],useAMS:true,amsMapping:[128]})),/material/i);
});
test('known dual-nozzle printers reject a scalar legacy report that cannot establish both nozzles', () => {
  assert.throws(() => check(fresh({model_id:'O1D'}),req({model:'h2d'})),/nozzle|ambiguous/i);
});
test('two external spool reports cannot silently select whichever happens to match', () => {
  assert.throws(() => check(fresh({vir_slot:[{id:'254',tray_type:'PLA'},{id:'255',tray_type:'PETG'}]})),/external|material|ambiguous/i);
});
test('H2C external spool 254 is its left holder even while the right holder 255 is reported too', () => {
  const serial='31BTEST';
  const h2c=vir_slot=>fresh({model_id:'O1C2',modules:[{name:'ota',sn:serial}],vir_slot},{serial});
  const job=(materials=['PLA'])=>req({model:'h2c',serial,nozzleDiameters:[],materials,useAMS:false});
  // Observed: 254 holds the PLA, 255 is empty.
  assert.doesNotThrow(() => check(h2c([{id:'254',tray_type:'PLA'},{id:'255',tray_type:''}]),job()));
  assert.throws(() => check(h2c([{id:'254',tray_type:'PETG'},{id:'255',tray_type:'PLA'}]),job()),/material/i);
  for(const slots of [[{id:'254',tray_type:'PLA'},{id:'254',tray_type:'PLA'}],[{id:'255',tray_type:'PLA'},{id:'253',tray_type:'PLA'}],
    [{id:'254',tray_type:'PLA'},{id:'255',tray_type:''},{id:'256',tray_type:''}]])
    assert.throws(() => check(h2c(slots),job()),/external|ambiguous|material/i);
});
test('old raw observations and fresh partial error reports cannot satisfy a new request', async () => {
  const printer = rawPrinter((_payload,emit) => emit({print:{command:'push_status',gcode_state:'IDLE',model_id:'C12'}}));
  printer.emit('rawMessage','device/01PTEST/report',Buffer.from(JSON.stringify({print:{command:'push_status',gcode_state:'IDLE',model_id:'C12',print_error:0,hms:[]}})));
  await assert.rejects(safety.readFreshPrinterStatus(printer,'01PTEST',20),/fresh|timed out/i);
});

test('a scalar file diameter is accepted only when every fresh physical nozzle matches', () => {
  const device={nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.4,type:'HH01',stat:0}]}};
  assert.doesNotThrow(() => check(fresh({model_id:'O1D',device}),req({model:'h2d'})));
});
test('modern external spool reports cannot be hidden by a matching legacy tray field', () => {
  assert.throws(() => check(fresh({vt_tray:{tray_type:'PLA'},vir_slot:[{id:'254',tray_type:'PETG'}]})),/material/i);
});

test('manual nozzle heating checks the loaded AMS material instead of an unrelated external spool', () => {
  const status=fresh({ams:{...ams,tray_now:'0'},vt_tray:{tray_type:'PA'}});
  const requirements=safety.manualHeatingRequirements(status,'p1s',0.4,'PA');
  assert.equal(requirements.useAMS,true);
  assert.deepEqual(requirements.amsMapping,[0]);
  assert.deepEqual(requirements.usedNozzleIndices,[0]);
  assert.throws(() => check(status,requirements),/material/i);
  assert.doesNotThrow(() => check(status,safety.manualHeatingRequirements(status,'p1s',0.4,'PLA')));
});
test('manual heating permits declared external or unloaded material and rejects unknown loaded AMS state', () => {
  for(const tray_now of ['254','255']) {
    const status=fresh({ams:{...ams,tray_now}});
    assert.doesNotThrow(() => check(status,safety.manualHeatingRequirements(status,'p1s',0.4,'PLA')));
  }
  for(const tray_now of [undefined,'',NaN,-1,'garbage']) {
    assert.throws(() => safety.manualHeatingRequirements(fresh({ams:{...ams,tray_now}}),'p1s',0.4,'PLA'),/loaded|tray|AMS/i);
  }
  assert.doesNotThrow(() => check(fresh(),safety.manualHeatingRequirements(fresh(),'p1s',0.4,'PLA')));
});
test('manual heating on a dual-nozzle printer needs the nozzle and checks the filament loaded there', () => {
  const extruder=snows=>({extruder:{info:snows.map((snow,id)=>({id,snow,info:0}))}});
  const nozzle={nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0},{id:1,diameter:0.4,type:'HH01',stat:0}]}};
  const status=snows=>fresh({model_id:'O1D',device:{...nozzle,...extruder(snows)},ams:{ams:[{id:'1',info:'2003',tray:[{id:'3',tray_type:'PETG'}]}]},vir_slot:[{id:'254',tray_type:'PLA'},{id:'255',tray_type:''}]});
  assert.throws(() => safety.manualHeatingRequirements(status([0xffff,0xffff]),'h2d',0.4,'PLA'),/dual-nozzle/i);
  // Right nozzle (0) loaded from AMS 1 slot 3 (snow 0x0103 = tray 7): PETG.
  const right=safety.manualHeatingRequirements(status([0x0103,0xffff]),'h2d',0.4,'PLA',0);
  assert.deepEqual([right.useAMS,right.amsMapping,right.usedNozzleIndices],[true,[7],[0]]);
  assert.throws(() => check(status([0x0103,0xffff]),right),/PETG in slot 7 contradicts/);
  assert.doesNotThrow(() => check(status([0x0103,0xffff]),safety.manualHeatingRequirements(status([0x0103,0xffff]),'h2d',0.4,'PETG',0)));
  // Left nozzle (1) fed from the external holder 254 (snow 0xFEFF): PLA.
  assert.doesNotThrow(() => check(status([0xffff,0xfeff]),safety.manualHeatingRequirements(status([0xffff,0xfeff]),'h2d',0.4,'PLA',1)));
  // Nothing loaded: the material's ceiling applies, no spool to compare.
  assert.equal(safety.manualHeatingRequirements(status([0xffff,0xffff]),'h2d',0.4,'PLA',1).verifyMaterials,false);
  assert.throws(() => safety.manualHeatingRequirements(fresh({model_id:'O1D',device:nozzle}),'h2d',0.4,'PLA',1),/filament loaded at that nozzle/);
  assert.throws(() => safety.manualHeatingRequirements(fresh(),'p1s',0.4,'PLA',1),/one nozzle/);
});

test('explicit job nozzle type and flow requirements cannot pass unknown reported configuration', () => {
  for(const [field,value] of [['nozzleTypes','hardened_steel'],['nozzleFlows','High Flow']]) {
    assert.throws(() => check(fresh({nozzle_type:undefined}),req({[field]:[value]})),/nozzle|type|flow/i);
    assert.throws(() => check(fresh(),req({[field]:['unrecognized']})),/nozzle|type|flow/i);
    assert.throws(() => check(fresh(),req({[field]:['']})),/nozzle|type|flow/i);
  }
});

test('legacy nozzle reports use Bambu standard-flow default and flag3 high-flow override', () => {
  assert.doesNotThrow(() => check(fresh(),req({nozzleFlows:['Standard']})));
  assert.throws(() => check(fresh({flag3:1024}),req({nozzleFlows:['Standard']})),/flow/i);
  assert.doesNotThrow(() => check(fresh({flag3:1024}),req({nozzleFlows:['High Flow']})));
  assert.throws(() => check(fresh({flag3:1024}),req({nozzleFlows:['Standard']})),/flow/i);
  // Studio's ParseV1_0 treats any other flag value as standard flow.
  assert.doesNotThrow(() => check(fresh({flag3:2048}),req({nozzleFlows:['Standard']})));
});

for (const [prefix, model, reportedModel] of [['039', 'a1', 'A1'], ['030', 'a1mini', 'A1M']]) {
  test(`${model} fresh OTA identity uses the correct serial prefix and rejects the other model`, async () => {
    const serial = `${prefix}TEST`;
    const printer = new EventEmitter();
    printer.publish = async payload => {
      const message = payload.pushing
        ? {print:{command:'push_status',gcode_state:'IDLE',print_error:0,hms:[],nozzle_diameter:'0.4',nozzle_type:'hardened_steel'}}
        : {info:{command:'get_version',module:[{name:'ota',sn:serial}]}};
      printer.emit('rawMessage',`device/${serial}/report`,Buffer.from(JSON.stringify(message)));
    };
    const status = await safety.readFreshPrinterStatus(printer,serial,50);
    assert.equal(status.model,model);
    assert.equal(status.observation.identitySource,'module-serial');
    const requirements = req({model});
    assert.doesNotThrow(() => check(status,requirements));
    assert.doesNotThrow(() => check({...status,raw:{...status.raw,model:reportedModel}},requirements));
    assert.throws(() => check(status,req({model:model === 'a1' ? 'a1mini' : 'a1'})),/model/i);
    assert.throws(() => check({...status,raw:{...status.raw,model:model === 'a1' ? 'A1M' : 'A1'}},requirements),/contradictory/i);
    assert.throws(() => check({...status,raw:{...status.raw,modules:[]}},requirements),/identity|model/i);
  });
}

test('H2C job nozzles (left, right) are matched to the printer report (id 1 left, id 0 right)', () => {
  // Observed H2C report: id 0 is the right nozzle with the induction hotend rack (ids 16+), id 1 the fixed left one.
  const serial='31BTEST';
  const status=fresh({model_id:'O1C2',modules:[{name:'ota',sn:serial}],nozzle_diameter:undefined,device:{nozzle:{info:[
    {id:0,diameter:0.4,type:'HS01',stat:0},{id:1,diameter:0.4,type:'HH05',stat:0},{id:16,diameter:0.6,type:'HS01',stat:0},{id:18,diameter:0.4,type:'HS01',stat:0}]}}},{serial});
  const job=(nozzleTypes,nozzleFlows)=>req({model:'h2c',serial,nozzleDiameters:[0.4,0.4],nozzleTypes,nozzleFlows});
  assert.doesNotThrow(()=>check(status,job(['tungsten_carbide','hardened_steel'],['high_flow','standard'])));
  assert.throws(()=>check(status,job(['hardened_steel','tungsten_carbide'],['standard','high_flow'])),/type|flow/i);
  // The nozzle material doesn't have to match the preset (Studio checks diameter and flow only).
  assert.doesNotThrow(()=>check(status,job(['hardened_steel','hardened_steel'],['high_flow','standard'])));
  assert.throws(()=>check(status,job(['tungsten_carbide','hardened_steel'],['standard','standard'])),/nozzle 1 flow/i);
  // Explicit physical selections keep the printer's own ids.
  assert.doesNotThrow(()=>check(status,req({model:'h2c',serial,nozzleDiameters:[0.4],usedNozzleIndices:[1],nozzleTypes:['tungsten_carbide'],nozzleFlows:['high_flow']})));
});
test('official H2C and H2D Pro returned serials agree with declared identity and reject conflicts', () => {
  for(const [prefix,model,modelId,other] of [['31B','h2c','O1C2','O1E'],['239','h2dpro','O1E','O1C2']]) {
    const serial=prefix+'TEST';
    const status=fresh({model_id:modelId,modules:[{name:'ota',sn:serial}]},{serial});
    assert.doesNotThrow(()=>check(status,req({model,serial,nozzleDiameters:[]})));
    assert.throws(()=>check(fresh({model_id:other,modules:[{name:'ota',sn:serial}]},{serial}),req({model,serial,nozzleDiameters:[]})),/identity|conflict|model/i);
    assert.throws(()=>check(fresh({model_id:undefined}),req({model,serial,nozzleDiameters:[]})),/identity|model/i);
  }
});

test('upload-only accepts any known printer state, including FAILED after a cancel, but keeps error gates', () => {
  const upload = extra => req({verifyMaterials:false,requireIdle:false,uploadOnly:true,...extra});
  for(const gcode_state of ['FAILED','PREPARE','SLICING','RUNNING','IDLE']) assert.doesNotThrow(() => check(fresh({gcode_state}),upload()), gcode_state);
  assert.deepEqual(check(fresh({gcode_state:'FAILED',print_error:0x0500400E}),upload()).hmsWarnings, ['print_error 0500-400E (the previous task stopped)']);
  for(const raw of [{gcode_state:'UNKNOWN'},{print_error:0x0300800A},{hms:[{attr:0x0C000100,code:0x00010001}]}]) assert.throws(() => check(fresh(raw),upload()), /state|error|HMS/i);
  // Identity and nozzles are still verified.
  assert.throws(() => check(fresh({gcode_state:'FAILED',nozzle_diameter:'0.6'}),upload()), /diameter/);
  assert.throws(() => check(fresh({gcode_state:'FAILED'}),upload({model:'x1c'})), /model/);
});

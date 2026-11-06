from pathlib import Path
def edit(name,fn):
 p=Path(name);p.write_text(fn(p.read_text(encoding='utf-8')),encoding='utf-8')
edit('src/lib/split-storage.ts',lambda s:s.replace('1 | 3 | 4 | 5 | 7 | 8 | 9','1 | 3 | 4 | 5 | 7 | 8 | 9 | 10 | 11').replace('1|3|4|5|7|8|9','1|3|4|5|7|8|9|10|11').replace('operation === 3 || operation === 8','operation === 3 || operation === 8 || operation === 11').replace('(data[4] | data[5] << 8) !== hand','(data[4] | data[5] << 8) === 0'))
edit('src-tauri/src/split_storage.rs',lambda s:s.replace('1..=9','1..=11').replace('[4,5,9]','[4,5,9,10,11]').replace('p[11]>9','p[11]>11'))
edit('src/lib/motor-profile-ui.ts',lambda s:s.replace('(p[12] | p[13] << 8) !== motor','(p[12] | p[13] << 8) > 16'))
edit('src/lib/app-store.tsx',lambda s:s.replace('id>65535','id>1296').replace('HandID 必须是 1～65535 的整数，且需连接主控','手编号必须为 TS-00～TS-ZZ，且需连接主控'))
edit('src/App.tsx',lambda s:s.replace('page === "cylinders" || page === "overview"','page === "cylinders" || page === "overview" || page === "registers"').replace(': <MotorToolbar />',': page !== "registers" ? <MotorToolbar /> : null').replace('<RegistersConfig />','<RegistersConfig cylinders={cylinders} />'))
edit('src/components/ui.tsx',lambda s:s.replace('  clampOnCommit = true,','  clampOnCommit = true,\n  onCommit,').replace('  clampOnCommit?: boolean;','  clampOnCommit?: boolean;\n  onCommit?: (value:number)=>void;').replace('  const [focus, setFocus] = useState(false);','  const [focus, setFocus] = useState(false);\n  const focusValue=useRef(value);',1).replace('      setText(String(v));','      setText(String(v));\n      if(onCommit && v!==Number(focusValue.current)){focusValue.current=v;onCommit(v);}',1).replace('onFocus={() => setFocus(true)}','onFocus={() => {focusValue.current=value;setFocus(true);}}',1))
edit('src/components/MotorToolbar.tsx',lambda s:s.replace('    <span className="motor-toolbar-status">','    <Button disabled={!app.connected || busy} onClick={()=>void run(()=>semanticMotion.clearFault(app.motor))}>清除故障</Button>\n    <span className="motor-toolbar-status">'))
edit('src/lib/motor-configuration.ts',lambda s:s.replace('max_rpm: 2000, limit_ma: 500, trip_ma: 600','max_rpm: 15000, limit_ma: 1000, trip_ma: 1000').replace('mode: "position_ramp", planning:','mode: "position_direct", planning:'))
edit('src/components/HandIdentity.tsx',lambda s:'import {formatHandId,parseHandId} from "../lib/hand-id";\n'+s.replace('String(app.handId)','formatHandId(app.handId)').replace('Number(value)','parseHandId(value)').replace('type="number" min={1} max={65535} step={1}','type="text" maxLength={5}').replace('width:68','width:88').replace('修改并保存 HandID（1～65535）','修改手编号 TS-00～TS-ZZ').replace('`${app.handId} · 修改`','`${formatHandId(app.handId)} · 修改`'))
def controls(s):
 start=s.index('      <div className="row-wrap" style={{ gap: 8 }}>')
 end=s.index('      <div className="motor-config-stack">',start)
 s=s[:start]+s[end:]
 s=s.replace('          <div className="motor-config-heading">运动与保护</div>\n','').replace('grid cols-4 motor-config-row','grid motor-config-row',1)
 s=s.replace('label="本次任务转速"','label="转速限制"').replace('label="持续过流 |Iq|"','label="电流限制 |Iq|"')
 s=s.replace('          </div>\n          <div className="row-wrap"><Button variant="primary"','          <div className="config-apply-actions"><Button variant="primary"',1)
 s=s.replace('"应用并回读中…" : "应用并回读"','"应用中…" : "应用"').replace('>读取已保存配置</Button></div>','>读取配置</Button></div></div>')
 s=s.replace('<section className="motor-config-section" aria-label="Ramp 配置">','<section className="motor-config-section ramp-inline" aria-label="Ramp 配置">')
 s=s.replace('<div className="motor-config-heading">Ramp <Badge tone={rampOn?"ok":"neutral"}>{rampOn?"已启用":"未启用"}</Badge></div>','<div className="motor-config-heading">RAMP <Toggle checked={rampOn} disabled={busy} label="开启 Ramp" onChange={v=>draft.setTask(c=>({...c,mode:v?"position_ramp":"position_direct"}))}/></div>')
 s=s.replace('          <div className="tiny muted">{cfg.mode==="velocity_ramp"?"加速与减速共用一个时间。":"最高转速共用本次任务转速。"}随运动配置应用并回读，并保存到当前电机档案。</div>','')
 s=s.replace('            <Check disabled={!positionRamp} checked={draft.ramp.velocity_ff} onChange={v=>draft.setRamp(c=>({...c,velocity_ff:v}))}>速度前馈</Check>','            <label className="row tiny">速度前馈 <Toggle disabled={!positionRamp} checked={draft.ramp.velocity_ff} onChange={v=>draft.setRamp(c=>({...c,velocity_ff:v}))} label="速度前馈"/></label>')
 s=s.replace('SelectField, Icon }','SelectField, Icon, Toggle }')
 s=s.replace('    <div className="stack">\n      <Card title="绝对位置"','    <div className="grid cols-2 position-work-grid">\n      <Card title="绝对位置"').replace('    </div>\n    <Card title="工况运行"','    <Card title="工况运行"').replace('    </Card>\n  </>;','    </Card></div>\n  </>;')
 return s
edit('src/components/SemanticControls.tsx',controls)
edit('src/pages/SemanticHoming.tsx',lambda s:s.replace('className="stack homing-operation"','className="homing-operation compact-homing"').replace('          <div className="tiny muted">使用主控已存找零参数，以及初始化时从 W25 写入 TMC 的 PI；双端均有效才开放绝对位置和工况。</div>\n          <div className="divider" />\n','').replace('            <div className="tiny muted">{!app.connected ? "串口未连接" : !s?.permit ? "需开启运动授权" : "运动授权已开启"}</div>\n',''))
def encoder(s):
 s=s.replace('<div className="tiny muted">{common&&image?', '<div className="encoder-config-footer"><div className="tiny muted">{common&&image?')
 s=s.replace('         <div className="divider"/>\n         <div className="row-wrap"><Button','         <div className="row"><Button size="sm"')
 s=s.replace('}>写入编码器配置并回读</Button>','}>应用</Button>')
 s=s.replace('<Button variant="ghost" disabled={busy||!app.connected||!!s?.motion_active} onClick={()=>void run(()=>read())}>读取配置</Button></div>','<Button size="sm" variant="ghost" disabled={busy||!app.connected||!!s?.motion_active} onClick={()=>void run(readActual)}>读取</Button></div></div>')
 return s
edit('src/pages/MainboardEncoder.tsx',encoder)
def align(s):
 s=s.replace('className="grid cols-4" style={{ gap: 10 }}>','className="grid align-inputs" style={{ gap: 10 }}>',1)
 s=s.replace('            </div>\n\n            <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>\n              <Field label="扫描上限"','              <Field label="扫描上限"',1)
 s=s.replace('<div className="row-wrap" style={{gap:16}}>','<div className="align-footer"><div className="row-wrap" style={{gap:16}}>',1)
 s=s.replace('            {commissionNote && <Notice tone={commissionBusy ? "warn" : "neutral"}>{commissionNote}</Notice>}\n','',1)
 s=s.replace('            </div>\n          </div>\n        </Card>','            </div></div>\n            {commissionNote && <Notice tone={commissionBusy ? "warn" : "neutral"}>{commissionNote}</Notice>}\n          </div>\n        </Card>',1)
 return s
edit('src/pages/Align.tsx',align)

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {matchOcrProposals} from '../server/ocr.mjs';

const data = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const augments = data.augments;
const eligible = augments.filter(item => item.availability === 'current' && item.recommendable !== false && !item.retiredPatch && !item.isInternalTemplate);
const byName = new Map(eligible.map(item => [item.name, item]));
const normal = text => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const title = (text, column, extra = {}) => ({text,x:[525,1135,1765][column],y:478,width:Math.max(50,text.length * 28),height:31,pass:'full-window',...extra});
const frame = lines => ({status:'recognized',diagnostics:{width:2560,height:1440},lines});
const run = (names, extras = []) => matchOcrProposals(frame([...names.map((name,index) => title(name,index)),...extras]),augments);

test('three exact titles in the real Windows OCR geometry become a confirmation draft in screen order', () => {
  const result = run(['钢化你心','歌利亚巨人','渴血']);
  assert.equal(result.status,'recognized');
  assert.deepEqual(result.proposals.map(item => item.name),['钢化你心','歌利亚巨人','渴血']);
  assert.ok(result.proposals.every(item => item.confidence === 'exact'));
  assert.match(result.message,/核对/);
  assert.ok(!('owned' in result));
  assert.equal(result.code,'title-layout-confirmed');
  assert.equal(result.diagnostics.layoutCount,1);
  assert.ok(!('text' in result) && !('lines' in result),'safe matching diagnostics never echo raw OCR text');
});

test('synthetic capture identity is exposed only after a complete title match and strips unrelated data', () => {
  const input = frame(['钢化你心','歌利亚巨人','渴血'].map((name,index)=>title(name,index)));
  input.selectionCapture = {capturedAt:1792800000000,width:2560,height:1440,originX:0,originY:0,windowHandle:'1234',privateText:'do not retain',
    regions:[0,1,2].map(column=>({column,x:400+column*600,y:300,width:400,height:700,signature:Array(192).fill(80),privateName:'do not retain'}))};
  const result = matchOcrProposals(input,augments);
  assert.equal(result.selectionMetadataStatus,'accepted');
  assert.equal(result.selectionCapture.regions.length,3);
  assert.doesNotMatch(JSON.stringify(result),/do not retain/);
  input.lines.pop();
  const incomplete = matchOcrProposals(input,augments);
  assert.equal('selectionCapture' in incomplete,false);
  assert.equal(incomplete.selectionMetadataStatus,'title-incomplete');
  input.lines.push(title('渴血',2)); input.selectionCapture.width = 1920;
  const invalid = matchOcrProposals(input,augments);
  assert.equal('selectionCapture' in invalid,false);
  assert.equal(invalid.selectionMetadataStatus,'shape-invalid');
  delete input.selectionCapture;
  assert.equal(matchOcrProposals(input,augments).selectionMetadataStatus,'missing');
});

test('synthetic shifted titles or reversed regions preserve candidates without automatic selection eligibility', () => {
  const names = ['钢化你心','歌利亚巨人','渴血'];
  const input = frame(names.map((name,column)=>title(name,column)));
  const metadata = {capturedAt:1792800000000,width:2560,height:1440,originX:0,originY:0,windowHandle:'1234',
    regions:[0,1,2].map(column=>({column,x:400+column*600,y:300,width:400,height:700,signature:Array(192).fill(80)}))};
  for (const mutate of [
    raw => { raw.lines[0].x = 200; },
    raw => { raw.lines.forEach(line => { line.y = 1002; }); },
    raw => { raw.selectionCapture.regions.reverse(); },
    raw => { raw.selectionCapture.regions.reverse().forEach((region,column)=>{region.column=column;}); },
  ]) {
    const raw = {...structuredClone(input),selectionCapture:structuredClone(metadata)};
    mutate(raw);
    const result = matchOcrProposals(raw,augments);
    assert.equal(result.status,'recognized');
    assert.deepEqual(result.proposals.map(item=>item.name),names);
    assert.equal('selectionCapture' in result,false);
    assert.equal(result.selectionMetadataStatus,raw.lines[0].x === 200 || raw.lines[0].y === 1002 ? 'title-outside-region' : 'shape-invalid');
  }
});

test('a battle player name containing Goliath and descriptions cannot become card offers', () => {
  const result = matchOcrProposals(frame([
    title('Goliath Astie',0),
    title('任务：钢化你心的效果触发了',1),
    title('获得邦！并增加伤害',2),
  ]),augments);
  assert.equal(result.status,'unavailable');
  assert.deepEqual(result.proposals,[]);
  assert.equal(run(['歌利亚巨人','钢化你心']).status,'unavailable','two HUD dictionary hits never claim that this is a choice screen');
});

test('short names are allowed only as complete titles, never as substrings', () => {
  for (const name of ['大力','渴血','易损','灵巧','虹吸','邦！','复位','装填']) {
    assert.ok(byName.has(name),`${name} exists in the real current catalog`);
    assert.equal(run([name,'钢化你心','歌利亚巨人']).proposals[0]?.name,name);
    assert.equal(run([`获得${name}的效果`,'钢化你心','歌利亚巨人']).status,'unavailable');
  }
});

test('longer exact names win over embedded catalog names without substring matching', () => {
  for (const name of ['无限循环往复','终极循环往复','灵魂虹吸','属性叠属性叠属性！']) {
    const result = run([name,'钢化你心','歌利亚巨人']);
    assert.equal(result.proposals[0]?.name,name);
    assert.equal(result.proposals.length,3);
  }
  assert.equal(run(['无限循环往复','循环往复','歌利亚巨人']).proposals.length,3);
});

test('the current 244 selectable definitions are eligible, including every unique short name', () => {
  assert.equal(eligible.length,244);
  let checked = 0;
  for (const augment of eligible) {
    // Names differing only in punctuation need that punctuation in the OCR.
    const collisions = eligible.filter(item => normal(item.name) === normal(augment.name));
    if (collisions.length > 1 && !/[\p{P}\p{S}]/u.test(augment.name)) continue;
    const anchors = ['钢化你心','歌利亚巨人','渴血'].filter(name => name !== augment.name).slice(0,2);
    const result = run([augment.name,...anchors]);
    assert.equal(result.proposals[0]?.id,augment.id,augment.name);
    checked++;
  }
  assert.ok(checked >= 240);
});

test('OCR can split three titles from one line only with exact full coverage and word boxes', () => {
  const names = ['大力','无限循环往复','歌利亚巨人'];
  const words = names.map((text,column) => title(text,column));
  const raw = frame([{text:names.join(' '),x:525,y:478,width:1400,height:31,words}]);
  const result = matchOcrProposals(raw,augments);
  assert.deepEqual(result.proposals.map(item => item.name),names);
  assert.equal(matchOcrProposals(frame([{...raw.lines[0],text:`获得 ${raw.lines[0].text}`,words:[{text:'获得',x:300,y:478,width:60,height:31},...words]}]),augments).status,'unavailable');
  assert.equal(matchOcrProposals(frame([{...raw.lines[0],words:undefined}]),augments).status,'unavailable','a merged line without geometry cannot prove three card columns');
});

test('separate frames, passes, vertical rows and duplicate names cannot be combined into an offer', () => {
  const names = ['大力','无限循环往复','歌利亚巨人'];
  for (const lines of [
    names.map((name,index) => title(name,index,{frameId:String(index)})),
    names.map((name,index) => title(name,index,{pass:String(index)})),
    names.map((name,index) => title(name,index,{y:300+index*150})),
    names.map((name,index) => title(name,index,{x:525})),
    names.map((name,index) => title(name,index,{y:1200})),
    ['大力','大力','歌利亚巨人'].map((name,index) => title(name,index)),
  ]) assert.equal(matchOcrProposals(frame(lines),augments).status,'unavailable');
  const conflicting = frame([
    ...names.map((name,index) => title(name,index,{frameId:'before'})),
    ...['渴血','易损','钢化你心'].map((name,index) => title(name,index,{frameId:'after'})),
  ]);
  assert.equal(matchOcrProposals(conflicting,augments).status,'unavailable');
});

test('missing geometry, misspellings, ambiguous punctuation and stale catalog names are not guessed', () => {
  assert.equal(matchOcrProposals({status:'recognized',lines:['大力','渴血','钢化你心'].map(text=>({text}))},augments).status,'unavailable');
  assert.equal(run(['钢化你芯','歌利亚巨人','渴血']).status,'unavailable');
  assert.equal(run(['罪恶快感','歌利亚巨人','渴血']).status,'unavailable');
  assert.equal(run(['罪恶快感！','歌利亚巨人','渴血']).proposals[0]?.name,'罪恶快感！');
  const retired = augments.find(item => item.availability !== 'current');
  assert.equal(run([retired.name,'歌利亚巨人','渴血']).status,'unavailable');
});

const crops = [{x:435,y:475,width:666,height:231},{x:973,y:475,width:614,height:231},{x:1459,y:475,width:666,height:231}];
const cropped = (text, column, extra = {}) => title(text,column,{x:[570,1170,1770][column],y:592,pass:'card-titles-color',frameId:'same-capture',region:'card-title',column,crop:crops[column],...extra});

test('scoped title passes recognize the actual missed title names with full-window coordinates', () => {
  const names = ['升级：耀光','贪欲束缚','急急小子'];
  assert.ok(names.every(name => byName.has(name)));
  const result = matchOcrProposals(frame(names.map((name,column) => cropped(name,column))),augments);
  assert.equal(result.status,'recognized');
  assert.deepEqual(result.proposals.map(item => item.name),names);
  assert.equal(result.diagnostics.titleRegionCount,3);
});

test('a scoped title split horizontally into OCR lines is rebuilt with whole visual-row coverage', () => {
  const split = [cropped('升级：',0,{width:84}),cropped('耀光',0,{x:656,width:56})];
  const lines = [...split,cropped('贪欲束缚',1),cropped('急急小子',2)];
  assert.deepEqual(matchOcrProposals(frame(lines),augments).proposals.map(item => item.name),['升级：耀光','贪欲束缚','急急小子']);
  assert.equal(matchOcrProposals(frame(lines.map(({region,column,crop,...line}) => line)),augments).status,'unavailable','full-window fragments never acquire relaxed title-region privileges');
  const contamination = [...split,cropped('玩家名字',0,{x:720,width:112}),cropped('贪欲束缚',1),cropped('急急小子',2)];
  assert.equal(matchOcrProposals(frame(contamination),augments).status,'unavailable','full visual row includes unrelated text and is rejected');
});

test('a scoped whole-column OCR line is separated into complete visual rows, never title substrings', () => {
  const names = ['升级：耀光','贪欲束缚','急急小子'];
  const lines = names.map((name,column) => {
    const words = [cropped('黄金阶',column,{y:530,width:84,height:20}),cropped(name,column),cropped('命中时获得额外伤害',column,{y:656,width:250,height:20})];
    return cropped(words.map(word => word.text).join(' '),column,{y:530,width:250,height:146,words});
  });
  const result = matchOcrProposals(frame(lines),augments);
  assert.deepEqual(result.proposals.map(item => item.name),names);
  const described = {...lines[0],text:'黄金阶 获得升级：耀光效果 命中时获得额外伤害',words:[lines[0].words[0],{...lines[0].words[1],text:'获得升级：耀光效果',width:252},lines[0].words[2]]};
  assert.equal(matchOcrProposals(frame([described,...lines.slice(1)]),augments).status,'unavailable');
  assert.equal(matchOcrProposals(frame(lines.map(({region,column,crop,...line}) => line)),augments).status,'unavailable','ordinary full-window lines keep exact complete-line rules');
});

test('a two-row exact title supersedes a catalog word that is only half of that title', () => {
  const lines = [cropped('灵魂',0,{width:56}),cropped('虹吸',0,{y:628,width:56}),cropped('贪欲束缚',1),cropped('急急小子',2)];
  const result = matchOcrProposals(frame(lines),augments);
  assert.deepEqual(result.proposals.map(item => item.name),['灵魂虹吸','贪欲束缚','急急小子']);
  assert.equal(matchOcrProposals(frame(lines.map(line => line.text === '虹吸' ? {...line,y:665} : line)),augments).status,'unavailable','distant text rows never form a title');
});

test('scoped OCR still rejects mixed passes, frames, malformed crops, misspellings and duplicate columns', () => {
  const names = ['升级：耀光','贪欲束缚','急急小子'];
  for (const alter of [
    line => ({...line,pass:`pass-${line.column}`}),
    line => ({...line,frameId:`frame-${line.column}`}),
    line => ({...line,crop:{...line.crop,y:0}}),
    line => ({...line,column:0}),
    line => ({...line,text:line.column === 0 ? '升级：耀先' : line.text}),
  ]) assert.equal(matchOcrProposals(frame(names.map((name,column) => alter(cropped(name,column)))),augments).status,'unavailable');
  const outOfBoundsWord = cropped('升级：耀光',0,{words:[{text:'升级：耀光',x:10,y:592,width:100,height:31}]});
  assert.equal(matchOcrProposals(frame([outOfBoundsWord,cropped('贪欲束缚',1),cropped('急急小子',2)]),augments).status,'recognized','invalid word geometry falls back to the exact complete line, not the out-of-crop word');
});

test('failure diagnostics identify empty, unmatched, incomplete and conflicting layouts without screen text', () => {
  assert.equal(matchOcrProposals(frame([]),augments).code,'ocr-no-text');
  const privateText = '私人玩家名字：升级耀先';
  const unmatched = matchOcrProposals(frame([title(privateText,0)]),augments);
  assert.equal(unmatched.code,'title-name-unmatched');
  assert.ok(!JSON.stringify(unmatched).includes(privateText));
  assert.equal(run(['贪欲束缚','急急小子']).code,'title-layout-incomplete');
  const ambiguous = matchOcrProposals(frame([
    ...['升级：耀光','贪欲束缚','急急小子'].map((name,column) => cropped(name,column)),
    ...['大力','易损','渴血'].map((name,column) => cropped(name,column,{pass:'card-titles-contrast'})),
  ]),augments);
  assert.equal(ambiguous.code,'title-layout-ambiguous');
  assert.equal(ambiguous.diagnostics.layoutCount,2);
  assert.ok(ambiguous.diagnostics.titleGeometry.every(box => Object.keys(box).every(key => ['x','y','width','height','column'].includes(key))));
});

test('native failures retain only fixed codes, stages and bounded numeric diagnostics', () => {
  const result = matchOcrProposals({status:'unavailable',code:'ocr-passes-incomplete',stage:'result',message:'本次识别未完成',text:'私人的屏幕内容',diagnostics:{width:2560,height:1440,passesCompleted:1,passesFailed:2,elapsedMs:4500,budgetReached:true,errorType:'Private.Player.Name',lastPassErrorType:'Private.Path',text:'screen text'}},augments);
  assert.equal(result.code,'ocr-passes-incomplete');
  assert.equal(result.stage,'result');
  assert.deepEqual(result.diagnostics,{width:2560,height:1440,passesCompleted:1,passesFailed:2,elapsedMs:4500,budgetReached:true});
  assert.ok(!JSON.stringify(result).includes('Private') && !JSON.stringify(result).includes('私人的屏幕内容'));
  const arbitrary = matchOcrProposals({status:'waiting',code:'private-player-name',stage:'C:\\private\\path',diagnostics:{width:Infinity,elapsedMs:-1}},augments);
  assert.equal(arbitrary.code,'ocr-unavailable');
  assert.equal(arbitrary.stage,'native');
  assert.deepEqual(arbitrary.diagnostics,{});
});


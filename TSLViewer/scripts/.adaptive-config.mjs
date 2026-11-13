import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false});let id=Date.now()>>>0;
const send=(operation,offset=0,data=[])=>h.invoke('motor_storage',{motor:0,request:{id,operation,offset,data}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function job(op,data){
 id++;
 if(data)for(const offset of [0,106]){const r=await send(2,offset,data.slice(offset,offset+106));if(r.result||r.phase!==1)throw Error('Stage '+JSON.stringify(r));}
 let r=await send(op);const deadline=Date.now()+60000;
 while([2,3].includes(r.phase)){if(Date.now()>deadline)throw Error('Storage timeout');await pause(80);r=await send(6);}
 if(r.result||r.phase!==4)throw Error('Storage '+JSON.stringify(r));
 const tail=await send(6,106);if(tail.result||tail.generation!==r.generation)throw Error('Fragment mismatch');
 return Buffer.from([...r.data,...tail.data]);
}
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
try {
 const b=await job(7);console.log('BEFORE',b.subarray(8,20).toString('hex'));
 b.writeUInt16LE(200,8);b.writeUInt16LE(800,14);b.writeUInt32LE(crc32(b.subarray(0,120)),120);
 await job(8,[...b]);const actual=await job(7);
 if(!actual.equals(b))throw Error('Independent Flash read mismatch');
 console.log('VERIFIED',actual.subarray(8,20).toString('hex'));
 console.log('HOME',await h.invoke('main_control',{motor:1,op:16,data:[]}));
}finally{await h.close();}

import {hardware} from './.m1-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-enable-failure-readonly.json',{managed:false});
try {console.log('STATE',await h.command(1,{kind:'position_state'}));await h.failure();}finally{await h.close();}

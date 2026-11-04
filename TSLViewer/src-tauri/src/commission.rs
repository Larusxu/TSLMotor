//! Compose existing encoder/PID/alignment/home/storage protocols; no foreign register map.
use std::{thread, time::{Duration,Instant}};
use serde::Deserialize;
use crate::{homing, motor_control, procs, storage};

#[derive(Deserialize)]
pub struct Config {
    pub motor:u8, pub kind:String, pub save:bool,
    pub encoder:procs::EncoderCfg, pub pid:procs::PidCfg, pub alignment:procs::CalibCfg,
    pub home:homing::HomingConfig, pub seek:homing::HomingParams,
}
pub fn run(ctx:&mut procs::Ctx, c:Config)->Result<serde_json::Value,String> {
    if !(1..=16).contains(&c.motor) || !["full","force","rehome","encoder","home"].contains(&c.kind.as_str()) {
        return Err("标定类型/电机号无效".into());
    }
    c.home.validate()?;let start=homing::encode_start(&c.seek)?;
    if c.home.limit_ma as f64 > c.pid.torque_limit_ma || c.home.max_rpm as f64 > c.pid.vel_limit_rpm {
        return Err("找零任务限制超过PID驱动器档案上限；请调整任务参数".into());
    }
    if !c.alignment.write_back || c.alignment.dry_run {return Err("组合标定要求真实标定并写回".into());}
    let link=ctx.link.clone();
    link.stop_rtmi()?;link.focus_motor(c.motor)?;
    let result=(|| {
        let info=link.gateway_control(c.motor,4,&[])?;
        if info.len()!=10 || info[7]==0 || info[9]&(1<<(info[2]-1))==0 {return Err("请先开启该路逻辑电源".into());}
        let h=motor_control::home(&link,c.motor)?;
        if c.seek.dual_limit && !h.dual_supported {return Err("主控固件不支持双端找零，请先升级配套固件".into());}
        if h.stage==1 {return Err("找零正在进行，请先取消".into());}
        let skip_encoder=(c.kind=="home") || ((c.kind=="full" || c.kind=="rehome") && h.zero_valid);
        let skip_home=c.kind=="encoder" || (c.kind=="full" && h.zero_valid);
        let mut calibration=None;
        let check=|| if ctx.cancelled(){Err("标定已取消".to_string())}else{Ok(())};
        check()?;
        if !skip_encoder {
            procs::setup_encoder(ctx,&c.encoder)?;
            if ctx.cancelled(){return Err("标定已取消".into());}
            calibration=Some(procs::calibrate_phi_e(ctx,&c.alignment,14)?);
            if !calibration.as_ref().is_some_and(|r|r.written) {return Err("对齐拟合未通过或未写回，禁止继续找零".into());}
        }
        if ctx.cancelled(){return Err("标定已取消".into());}
        let pid=procs::apply_pid(ctx,&c.pid)?;
        if pid["checks"].as_array().map_or(true,|a|a.iter().any(|v|v["ok"]!=true)) {return Err("PID写入回读不一致".into());}
        if !skip_home {
            if ctx.cancelled(){return Err("标定已取消".into());}
            if !link.write_verified(0x100,crate::regs::motor_motion(crate::regs::MODE_PWM_OFF,c.encoder.poles,false,false),0xffff)? {
                return Err("找零前电机类型/极对数写回失败".into());
            }
            let gdrv=link.read_reg_retry(0x101,2)?;
            if !link.write_verified(0x101,gdrv | (1<<31) | (1<<16),0x80010000)? {return Err("驱动使能写回失败".into());}
            let bytes=c.home.encode()?;
            if link.gateway_control(c.motor,15,&bytes)?!=[1] || link.gateway_control(c.motor,16,&[])?!=bytes {return Err("找零参数回读失败".into());}
            ctx.begin("主控机械找零");
            if link.gateway_control(c.motor,12,&start)?!=[1] {return Err("主控拒绝找零".into());}
            let began=Instant::now();
            loop {
                if ctx.cancelled(){return Err("标定已取消".into());}
                let h=motor_control::home(&link,c.motor)?;
                if c.seek.dual_limit && !h.dual_supported {return Err("主控固件不支持双端找零，请先升级配套固件".into());}
                if h.stage==2 && (!c.seek.dual_limit || h.zero_valid) {break;}
                if h.stage==3 {return Err(format!("找零失败：{} (error={})",h.message,h.error));}
                let legs = if c.seek.dual_limit {2} else {1};
                if began.elapsed()>Duration::from_secs(c.home.timeout_s as u64*legs+5) {return Err("等待找零终态超时".into());}
                thread::sleep(Duration::from_millis(150));
            }
            ctx.ok("主控机械找零",if c.seek.dual_limit {"双端行程有效；仅RAM保存，断逻辑电源失效"} else {"单端已记录；完整行程仍需双端找零"});
            thread::sleep(Duration::from_millis(300));
        }
        if ctx.cancelled(){return Err("标定已取消".into());}
        let mut saved=None;
        if c.save {
            ctx.begin("保存电角度与闭环参数（不保存运行零点）");
            let params=storage::StoreParams {
                cpr:c.encoder.cpr,poles:c.encoder.poles,csa_gain:c.encoder.csa_gain,pwm_max_count:c.encoder.pwm_max_count,
                phi_e_offset:link.read_reg_retry(0x242,3)?&0xffff,
                torque_limit_ma:c.pid.torque_limit_ma.round() as u32,flux_limit_ma:c.pid.flux_limit_ma.round() as u32,
                vel_limit_rpm:c.pid.vel_limit_rpm.round() as u32,uq_ud_limit:c.pid.uq_ud_limit,
                cur_p:c.pid.torque_p as u32,cur_i:c.pid.torque_i as u32,vel_p:c.pid.vel_p as u32,vel_i:c.pid.vel_i as u32,
                pos_p:c.pid.pos_p as u32,pos_i:c.pid.pos_i as u32,flags:1,motor_id:c.motor as u32,
                counts_per_rpm_x10:(c.pid.counts_per_rpm*10.0).round() as u32,
                ma_per_count_ua:(c.pid.ma_per_count*1000.0).round() as u32,..Default::default()
            };
            saved=Some(storage::save(&link,&params)?);
            ctx.ok("保存参数","已完成并回读校验");
        }
        Ok(serde_json::json!({"calibration":calibration,"home":motor_control::home(&link,c.motor)?,"saved":saved}))
    })();
    if result.is_err() {let _=link.gateway_control(c.motor,14,&[]);thread::sleep(Duration::from_millis(800));}
    if link.write_verified(0x100,0,0xffffffff).unwrap_or(false)==false {
        let _=link.gateway_control(c.motor,5,&[0]);
        return Err("收尾PWM关闭无法确认，已请求逻辑断电；标定结果不可视为完整成功".into());
    }
    result
}

//! TMC6460 Rev.0 pp.104-106: complete singular ROM commands.
//! This module deliberately knows no M24C02 byte addressing convention.
use crate::link::{Link, LinkError, Result};
use crate::regs;
use std::time::{Duration, Instant};

pub trait Port {
    fn write(&mut self, reg: u16, value: u32) -> Result<()>;
    fn read(&mut self, reg: u16) -> Result<u32>;
    fn elapsed_ms(&self) -> u64;
    fn yield_poll(&mut self);
}

pub struct LinkPort<'a> { link: &'a Link, started: Instant }
impl<'a> LinkPort<'a> {
    pub fn new(link: &'a Link) -> Self { Self { link, started: Instant::now() } }
}
impl Port for LinkPort<'_> {
    fn write(&mut self, reg: u16, value: u32) -> Result<()> { self.link.write_reg(reg, value) }
    fn read(&mut self, reg: u16) -> Result<u32> { self.link.read_reg_retry(reg, 1) }
    fn elapsed_ms(&self) -> u64 { self.started.elapsed().as_millis() as u64 }
    fn yield_poll(&mut self) { std::thread::sleep(Duration::from_millis(1)); }
}

fn wait_echo(port: &mut impl Port, command: u32, deadline: u64) -> Result<()> {
    loop {
        if port.elapsed_ms() >= deadline { return Err(LinkError::Timeout); }
        let actual = port.read(regs::IO_RESPONSE_0)?;
        if port.elapsed_ms() >= deadline { return Err(LinkError::Timeout); }
        if actual == command { return Ok(()); }
        port.yield_poll();
    }
}

/// Caller owns the entire IO-controller session, including stopping PWM,
/// configuring pins, restoring SSI and verifying fresh feedback. An echo does
/// not prove the EEPROM address mapping, write completion or data integrity.
/// Deadline covers idle and command; individual Link calls have their own
/// transport timeout and cannot be preempted by this synchronous PC helper.
pub fn execute(port: &mut impl Port, command: u32, result: bool, timeout_ms: u64) -> Result<Option<u32>> {
    if command == 0 || timeout_ms == 0 || timeout_ms > 5000 {
        return Err(LinkError::ValueError("Invalid ROM command/deadline".into()));
    }
    let deadline = port.elapsed_ms().saturating_add(timeout_ms);
    port.write(regs::IO_COMMAND, 0)?;
    wait_echo(port, 0, deadline)?;
    port.write(regs::IO_COMMAND, command)?;
    wait_echo(port, command, deadline)?;
    if result {
        let value = port.read(regs::IO_RESPONSE_1)?;
        if port.elapsed_ms() >= deadline { return Err(LinkError::Timeout); }
        Ok(Some(value))
    } else { Ok(None) }
}

pub fn i2c_command(address: usize, write: Option<u16>) -> Result<u32> {
    if address > 0xfff { return Err(LinkError::ValueError("ROM address exceeds 12 bits".into())); }
    Ok(match write {
        None => 0xd000_0000 | ((address as u32) << 16),
        Some(word) => 0xe000_0000 | ((address as u32) << 16) | u32::from(word),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake { echo: u32, now: u64, events: Vec<(u16, Option<u32>)>,
                  hold_idle: bool, hold_command: bool, fail_at: usize, executions: usize }
    impl Port for Fake {
        fn write(&mut self, r: u16, v: u32) -> Result<()> {
            self.events.push((r, Some(v)));
            if self.events.len() == self.fail_at { return Err(LinkError::Corrupt); }
            if v != self.echo && v != 0 { self.executions += 1; }
            if !(v == 0 && self.hold_idle || v != 0 && self.hold_command) { self.echo = v; }
            Ok(())
        }
        fn read(&mut self, r: u16) -> Result<u32> {
            self.events.push((r, None));
            if self.events.len() == self.fail_at { return Err(LinkError::Corrupt); }
            Ok(if r == regs::IO_RESPONSE_0 { self.echo } else { 0xa55a })
        }
        fn elapsed_ms(&self) -> u64 { self.now }
        fn yield_poll(&mut self) { self.now += 1; }
    }
    #[test]
    fn raw_words_are_not_truncated_or_address_wrapped() {
        assert_eq!(i2c_command(0xabc, Some(0xa55a)).unwrap(), 0xeabc_a55a);
        assert_eq!(i2c_command(0xfff, None).unwrap(), 0xdfff_0000);
        assert!(i2c_command(0x1000, None).is_err());
    }
    #[test]
    fn identical_commands_execute_twice_after_idle_confirmation() {
        let mut p = Fake::default();
        for _ in 0..2 { assert_eq!(execute(&mut p, 0xd0120000, true, 50).unwrap(), Some(0xa55a)); }
        assert_eq!(p.executions, 2);
        assert_eq!(&p.events[..5], &[(0x381,Some(0)),(0x382,None),
            (0x381,Some(0xd0120000)),(0x382,None),(0x383,None)]);
    }
    #[test]
    fn stale_final_echo_cannot_bypass_idle() {
        let mut p = Fake { echo: 0xd0120000, hold_idle: true, ..Fake::default() };
        assert!(execute(&mut p, 0xd0120000, true, 50).is_err());
        assert!(!p.events.iter().any(|(r,v)| *r==0x383 || *v==Some(0xd0120000)));
    }
    #[test]
    fn missing_completion_never_reads_result() {
        let mut p = Fake { hold_command: true, ..Fake::default() };
        assert!(execute(&mut p, 0xd0120000, true, 50).is_err());
        assert!(!p.events.iter().any(|(r,_)| *r==0x383));
    }
    #[test]
    fn each_transport_error_stops_the_sequence() {
        for n in 1..=5 {
            let mut p = Fake { fail_at: n, ..Fake::default() };
            assert!(execute(&mut p, 0xd0120000, true, 50).is_err());
            assert_eq!(p.events.len(), n);
        }
    }
}

//! Adapter that puts the TSLHand simulator (`TSLMotor/TSLmoni`) behind the
//! serial `gateway::Wire` seam, so the whole protocol stack runs unchanged.
//!
//! Everything that models the controller lives in the `tslmoni` crate; this
//! file only bridges it to `Transport`.

use std::cell::RefCell;
use std::io::{self, Read, Write};

use serialport::ClearBuffer;
use tslmoni::Simulator;

use crate::gateway::{Transport, Wire};

pub use tslmoni::{is_sim_port, PORT_NAME};

/// `Transport` wired to the in-process simulator instead of a serial port.
pub fn transport(mode: &str, motor: u8) -> Transport {
    Transport::from_wire(Box::new(SimWire::new(mode, motor)), mode, motor)
}

struct SimWire {
    sim: RefCell<Simulator>,
}

impl SimWire {
    fn new(mode: &str, motor: u8) -> Self {
        Self {
            // Persistent EEPROM images: a parameter block saved in simulation is
            // still there after reconnecting (see `tslmoni::Simulator::new_persistent`).
            sim: RefCell::new(Simulator::new_persistent(mode, motor)),
        }
    }
}

impl Read for SimWire {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        Ok(self.sim.borrow_mut().read(b))
    }
}

impl Write for SimWire {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.sim.borrow_mut().write(b);
        Ok(b.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Wire for SimWire {
    fn clear(&self, _which: ClearBuffer) -> io::Result<()> {
        self.sim.borrow_mut().clear();
        Ok(())
    }

    fn available(&self) -> io::Result<u32> {
        Ok(self.sim.borrow_mut().available() as u32)
    }
}

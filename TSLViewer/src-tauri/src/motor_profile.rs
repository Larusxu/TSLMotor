//! MCU-owned MTR1 W25 archive payload. The historical dual-slot codec below
//! is retained for offline migration tests; never use it for physical M24.
//! No serial access and no implicit
//! migration of TSL1 (which persisted obsolete mechanical coordinates).
//! Keep identical to firmware los_moto_profile.c; golden vector is generated
//! by the actual C implementation, not by this decoder.
pub const SIZE: usize = 128;
pub const COMMIT: u32 = 0x31544d43;
pub const PI_MASK: u32 = 0x007fffff;
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub generation: u32,
    pub motor_id: u16,
    pub board_slot_id: u16,
    pub flags: u16,
    pub pole_pairs: u8,
    pub sensor_direction: u8,
    /// Offset, quality, PI config, Id/Iq/speed/position PI, current/velocity/
    /// voltage driver limits, profile flags, common-profile hash.
    pub words: [u32; 12],
    pub run: [u32; 13],
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Error { Length, Empty, Schema, Crc, Binding, Hash, Range, Legacy, Conflict }
pub fn crc32(p: &[u8]) -> u32 {
    let mut c = u32::MAX;
    for b in p {
        c ^= *b as u32;
        for _ in 0..8 { c = (c >> 1) ^ (0u32.wrapping_sub(c & 1) & 0xedb88320); }
    }
    !c
}
fn u16_at(p: &[u8], i: usize) -> u16 { u16::from_le_bytes([p[i], p[i+1]]) }
fn u32_at(p: &[u8], i: usize) -> u32 { u32::from_le_bytes(p[i..i+4].try_into().unwrap()) }
impl Profile {
    pub fn validate(&self) -> Result<(), Error> {
        let w=&self.words;
        let run2=self.run[0]==0x324e5552;
        if !(1..=16).contains(&self.motor_id) || !(1..=16).contains(&self.board_slot_id)
            || self.flags & !3 != 0 || self.pole_pairs == 0 || self.pole_pairs > 127
            || self.sensor_direction > 1 || w[0] > 65535 || w[2] & !PI_MASK != 0
            || w[7] & 0x80008000 != 0 || w[8] > 0x7fffffff || w[9] > 65535
            || (!run2&&w[10]!=0) || (run2&&(w[10]==0||w[10]>0x7fffffff)) || w[11] == 0
            || (self.flags & 2 != 0 && (w[3..7].contains(&0) || w[7] >> 16 == 0 || w[8] == 0 || w[9] == 0))
        { return Err(Error::Range); }
        let r=&self.run;
        if r[0]==0 {if r.iter().any(|v|*v!=0){return Err(Error::Schema);}}
        else if (r[0]!=0x314e5552&&!run2) || r[1]==0||r[1]>0x7fffff||r[2]==0||r[2]>0x7fffff||
            r[3]==0||r[3]>32767||r[4]<20||r[4]>10000||r[5]<20||r[5]>1000||
            r[6]<100||r[6]>5000||r[6]<2*r[5]||r[4]<r[5]||r[7]<r[6]||r[7]>10000||
            r[8]==0||r[9]>3||!(1..=2).contains(&r[10])||
            (!run2&&(r[11]>0x7fffff||r[11]>=w[8]))||
            (run2&&(r[11]==0||r[11]>0x7ffffff||r[11]>if r[9]>=2{w[10]}else{w[8]}))||
            r[12]>0x7fffff||r[12]>w[8]||(r[9]==3&&r[1]!=r[2]) {return Err(Error::Range);}
        Ok(())
    }
    pub fn encode(&self) -> Result<[u8; SIZE], Error> {
        self.validate()?;
        let mut p=[0;SIZE];p[..4].copy_from_slice(b"MTR1");
        p[4..6].copy_from_slice(&1u16.to_le_bytes());p[6..8].copy_from_slice(&128u16.to_le_bytes());
        p[8..12].copy_from_slice(&self.generation.to_le_bytes());
        p[12..14].copy_from_slice(&self.motor_id.to_le_bytes());p[14..16].copy_from_slice(&self.board_slot_id.to_le_bytes());
        p[16..18].copy_from_slice(&self.flags.to_le_bytes());p[18]=self.pole_pairs;p[19]=self.sensor_direction;
        for (i,w) in self.words.iter().enumerate() {p[20+4*i..24+4*i].copy_from_slice(&w.to_le_bytes());}
        for (i,w) in self.run.iter().enumerate(){p[68+4*i..72+4*i].copy_from_slice(&w.to_le_bytes());}
        let crc=crc32(&p[..120]);p[120..124].copy_from_slice(&crc.to_le_bytes());
        p[124..128].copy_from_slice(&COMMIT.to_le_bytes());Ok(p)
    }
    pub fn decode(p: &[u8], motor: u16, slot: u16, hash: u32) -> Result<Self, Error> {
        if p.len()!=SIZE {return Err(Error::Length);}
        if &p[..4]!=b"MTR1" || u32_at(p,124)!=COMMIT {return Err(Error::Empty);}
        if u16_at(p,4)!=1 || u16_at(p,6)!=128 {return Err(Error::Schema);}
        if u32_at(p,120)!=crc32(&p[..120]) {return Err(Error::Crc);}
        if u16_at(p,12)!=motor || u16_at(p,14)!=slot {return Err(Error::Binding);}
        if u32_at(p,64)!=hash {return Err(Error::Hash);}
        let mut run=[0;13];for (i,w) in run.iter_mut().enumerate(){*w=u32_at(p,68+4*i);}
        let mut words=[0;12];for (i,w) in words.iter_mut().enumerate() {*w=u32_at(p,20+4*i);}
        let v=Self {generation:u32_at(p,8),motor_id:motor,board_slot_id:slot,
            flags:u16_at(p,16),pole_pairs:p[18],sensor_direction:p[19],words,run};
        v.validate()?;Ok(v)
    }
}
pub fn select(p: &[u8], motor:u16, slot:u16, hash:u32) -> Result<(usize,Profile),Error> {
    if p.len()!=256 {return Err(Error::Length);}
    let a=Profile::decode(&p[..128],motor,slot,hash);let b=Profile::decode(&p[128..],motor,slot,hash);
    match (a,b) {
        (Ok(a),Ok(b))=>{
            let d=b.generation.wrapping_sub(a.generation);
            if d==0x80000000 || (d==0 && a!=b) {Err(Error::Conflict)}
            else if d!=0 && d<0x80000000 {Ok((1,b))} else {Ok((0,a))}
        },
        (Ok(a),Err(_))=>Ok((0,a)),(Err(_),Ok(b))=>Ok((1,b)),
        (Err(a),Err(b))=>if &p[..4]==b"TSL1" || &p[112..116]==b"TSL1" {Err(Error::Legacy)}
            else {Err(if a!=Error::Empty {a} else {b})},
    }
}
/// Detect both committed and interrupted new records before a legacy writer
/// touches its overlapping block B or its 0xFE scratch byte.
pub fn new_layout(p: &[u8]) -> bool {
    p.len()==256 && (&p[..4]==b"MTR1" || &p[128..132]==b"MTR1")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn run2_roundtrip_and_independent_ceilings() {
        let p=include_bytes!("../../tests/fixtures/motor-profile-v1.bin");
        let mut v=Profile::decode(p,9,9,0x12345678).unwrap();
        v.words[10]=8774555;
        v.run=[0x324e5552,667,667,2980,180,60,1000,5000,65536,1,2,152709,1];
        let image=v.encode().unwrap();
        assert_eq!(Profile::decode(&image,9,9,0x12345678).unwrap(),v);
        v.run[11]=v.words[8]+1;assert_eq!(v.validate(),Err(Error::Range));
        v.run[9]=2;assert!(v.validate().is_ok());
        v.run[11]=v.words[10]+1;assert_eq!(v.validate(),Err(Error::Range));
    }
    #[test]
    fn c_firmware_golden_vector() {
        let p=include_bytes!("../../tests/fixtures/motor-profile-v1.bin");
        let v=Profile::decode(p,9,9,0x12345678).unwrap();
        assert_eq!(v.words[0],43210);assert_eq!(v.encode().unwrap(),*p);
        assert_eq!(Profile::decode(p,8,9,0x12345678),Err(Error::Binding));
        assert_eq!(Profile::decode(p,9,9,1),Err(Error::Hash));
        let mut q=*p;q[33]^=1;assert_eq!(Profile::decode(&q,9,9,0x12345678),Err(Error::Crc));
    }
    #[test]
    fn generation_conflict_and_legacy_are_explicit() {
        let p=include_bytes!("../../tests/fixtures/motor-profile-v1.bin");
        let mut v=Profile::decode(p,9,9,0x12345678).unwrap();let mut image=[255;256];
        v.generation=u32::MAX;image[..128].copy_from_slice(&v.encode().unwrap());
        v.generation=0;image[128..].copy_from_slice(&v.encode().unwrap());
        assert_eq!(select(&image,9,9,0x12345678).unwrap().0,1);assert!(new_layout(&image));
        v.generation=u32::MAX;v.words[0]+=1;image[128..].copy_from_slice(&v.encode().unwrap());
        assert_eq!(select(&image,9,9,0x12345678),Err(Error::Conflict));
        image.fill(255);image[..4].copy_from_slice(b"TSL1");
        assert_eq!(select(&image,9,9,0x12345678),Err(Error::Legacy));
    }
}

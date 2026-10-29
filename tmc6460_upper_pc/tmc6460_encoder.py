# -*- coding: utf-8 -*-
"""TMC6460 SSI encoder configuration module
Based on verified config from tmc6460_motor_test_console project
"""
import time

# IO_CONTROLLER register addresses (source: tmc6460.pdf Page 130)
IO_CMD   = 0x381
IO_RESP0 = 0x382
IO_RESP1 = 0x383
IO_RESP2 = 0x384
IO_RESP3 = 0x385

ENCODER_ANGLE_ADDR = 0x24D  # FEEDBACK.PHI_EXT_A

ENCODER_PRESETS = {
    "MT6701 (SSI, 14-bit)": {
        "description": "MT6701 SSI, 14-bit, bench verified",
        "spi_bus_mode": 1,
        "spi_frequency_hz": 2_000_000,
        "spi_bits": 14,
        "spi_data_mask": 0x00003FFF,
        "spi_send_data": 0x00000000,
        "spi_idle_time": 16,
        "phi_e_offset": 48000,
    },
    "MT6701 (SSI, 24-bit)": {
        "description": "MT6701 SSI, 24-bit complete frame",
        "spi_bus_mode": 1,
        "spi_frequency_hz": 2_000_000,
        "spi_bits": 24,
        "spi_data_mask": 0x00FFFFFF,
        "spi_send_data": 0x00000000,
        "spi_idle_time": 48,
        "phi_e_offset": 48000,
    },
}


def _freq_config(hz, f_sys=60_000_000):
    half = round(f_sys / (2.0 * hz)) - 1
    return max(0, min(255, half))


def build_spi_cmd(spi_bus_mode=1, spi_freq=2_000_000, spi_bits=14,
                  spi_idle=16, csn_enc_n=True):
    hp = _freq_config(spi_freq)
    u = (spi_bits - 1) & 0x1F
    if csn_enc_n:
        u |= 0x80
    cmd = 0xF0000000
    cmd |= (spi_bus_mode & 3) << 26
    cmd |= 2 << 24  # request_type=2: poll->PHI_EXT_A
    cmd |= (spi_idle & 0xFF) << 16
    cmd |= (u & 0xFF) << 8
    cmd |= (hp & 0xFF)
    return cmd


def setup_encoder(tmc, preset_name="MT6701 (SSI, 14-bit)", pole_pairs=2, csn_via_enc_n=True, timeout=1.0, phi_e_offset=None):
    """One-click encoder setup.
    tmc: TMC6460Serial instance (must be connected)
    Returns: (success: bool, message: str)
    """
    preset = ENCODER_PRESETS.get(preset_name)
    if preset is None:
        return False, f"Unknown preset: {preset_name}"

    def wr(addr, val):
        return tmc.write_register(addr, val)

    def rd(addr):
        for attempt in range(3):
            result = tmc.read_register(addr)
            if result is not None:
                return result
            time.sleep(0.02)
        return None

    # 1. Stop IO Controller
    wr(IO_CMD, 0x00000000)
    wr(IO_RESP0, 0x00000000)
    time.sleep(0.05)

    # 2. IO_MATRIX: ENC_A=OUT0(SCK), ENC_B=IN0(SDI), ENC_N=IN1_OUT1(CSN), HALL_W=OUT2
    io_val = rd(0x006)
    if io_val is None:
        return False, "Read IO_MATRIX failed"
    mask = 0x3F | (7 << 12)
    new_io = (io_val & ~mask) | 0x3F | (3 << 12)
    if not wr(0x006, new_io):
        return False, "Write IO_MATRIX failed"

    # 3. Probe IO Controller firmware
    wr(IO_CMD, 0x00000000)
    time.sleep(0.02)
    wr(IO_CMD, 0xAA000000)
    time.sleep(0.05)
    fw = rd(IO_RESP1)
    if fw is None:
        return False, "IO Controller no response"
    fw_type = fw >> 8
    if fw_type not in (0x646000, 0x52414D):
        return False, f"IO Controller FW unsupported (0x{fw:08X})"

    # 4. CSA gain
    wr(0x0C3, 0x00000000)

    # 5. PWM
    wr(0x102, 0x00000017)
    wr(0x103, 300)

    # 6. Motor pole pairs
    wr(0x100, (3 << 7) | (pole_pairs & 0x7F))

    # 7. Feedback channel A
    wr(0x240, 0x07000400)
    wr(0x244, 0x000DA71E)
    wr(0x245, 0xFFF00001)
    wr(0x250, 0x00400001)
    offset_val = phi_e_offset if phi_e_offset is not None else preset.get("phi_e_offset", 0)
    wr(0x242, offset_val)

    # 8. Final: DATA_MASK -> SEND_DATA -> COMMAND (order matters!)
    wr(IO_CMD, 0x00000000)
    time.sleep(0.02)
    wr(IO_RESP2, preset["spi_data_mask"])
    wr(IO_RESP1, preset["spi_send_data"])
    cmd = build_spi_cmd(
        spi_bus_mode=preset["spi_bus_mode"],
        spi_freq=preset["spi_frequency_hz"],
        spi_bits=preset["spi_bits"],
        spi_idle=preset["spi_idle_time"],
        csn_enc_n=True
    )
    wr(IO_CMD, cmd)
    time.sleep(0.1)

    # Verify
    resp0 = rd(IO_RESP0)
    if resp0 is None or resp0 == 0:
        return False, "IO Controller did not execute command"

    return True, f"OK (CMD=0x{cmd:08X})"

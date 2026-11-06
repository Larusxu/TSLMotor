"""Design tokens and Qt style sheets.

The dark palette is a direct port of ``TSLViewer/src/styles/tokens.css``:
deep neutral surfaces, one electric accent (cyan), amber for attention and
rose for danger.  Light theme keeps the same geometry and inverts the chrome;
the oscilloscope stays dark on purpose.
"""

from __future__ import annotations

from dataclasses import dataclass

from PyQt6.QtGui import QColor, QFont, QFontDatabase

UI_FAMILIES = ["Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei"]
DISPLAY_FAMILIES = ["Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei"]
MONO_FAMILIES = ["Cascadia Code", "Cascadia Mono", "Consolas", "Microsoft YaHei UI"]


def ui_font(size: int = 13, weight: int = 400, display: bool = False) -> QFont:
    families = DISPLAY_FAMILIES if display else UI_FAMILIES
    available = set(QFontDatabase.families())
    family = next((f for f in families if f in available), "Sans Serif")
    font = QFont(family, size)
    font.setWeight(QFont.Weight(weight))
    font.setStyleStrategy(QFont.StyleStrategy.PreferAntialias)
    return font


def mono_font(size: int = 12, weight: int = 400) -> QFont:
    available = set(QFontDatabase.families())
    family = next((f for f in MONO_FAMILIES if f in available), "Consolas")
    font = QFont(family, size)
    font.setWeight(QFont.Weight(weight))
    font.setStyleHint(QFont.StyleHint.Monospace)
    return font


@dataclass(frozen=True)
class Theme:
    name: str
    bg: str
    bg_grad_a: str
    bg_grad_b: str
    surface: str
    surface_2: str
    surface_3: str
    inset: str
    line: str
    line_soft: str
    line_strong: str
    text: str
    text_2: str
    text_3: str
    text_4: str
    accent: str
    accent_dim: str
    accent_ink: str
    accent_soft: str
    accent_line: str
    violet: str
    blue: str
    ok: str
    ok_soft: str
    warn: str
    warn_soft: str
    danger: str
    danger_soft: str
    raise_1: str
    raise_2: str
    raise_3: str
    raise_4: str
    fill_1: str
    fill_2: str
    fill_3: str
    btn_accent_a: str
    btn_accent_b: str
    btn_danger_a: str
    btn_danger_b: str
    brand_a: str
    brand_b: str
    screen_a: str
    screen_b: str
    grid: str
    grid_ink: str
    rail_a: str
    rail_b: str
    topbar_bg: str
    legend_bg: str
    toast_bg: str
    ch: tuple[str, ...]

    def color(self, name: str) -> QColor:
        return QColor(getattr(self, name))

    def rgb(self, name: str, alpha: int | None = None) -> QColor:
        c = QColor(getattr(self, name))
        if alpha is not None:
            c.setAlpha(alpha)
        return c


DARK = Theme(
    name="dark",
    bg="#08090c",
    bg_grad_a="#0b1016",
    bg_grad_b="#08090c",
    surface="#10141a",
    surface_2="#141922",
    surface_3="#19202b",
    inset="#0a0d12",
    line="#232a36",
    line_soft="#1a202a",
    line_strong="#2e3746",
    text="#e8eef7",
    text_2="#a3b0c2",
    text_3="#6d7b8e",
    text_4="#4c5768",
    accent="#2ee6e6",
    accent_dim="#17b6bd",
    accent_ink="#04282b",
    accent_soft="#1F2EE6E6",
    accent_line="#572EE6E6",
    violet="#a78bfa",
    blue="#6ea8fe",
    ok="#3ddc84",
    ok_soft="#1F3DDC84",
    warn="#f5b544",
    warn_soft="#1FF5B544",
    danger="#ff5f6d",
    danger_soft="#1FFF5F6D",
    raise_1="#212a36",
    raise_2="#1a212b",
    raise_3="#202834",
    raise_4="#191f28",
    fill_1="#0AFFFFFF",
    fill_2="#0FFFFFFF",
    fill_3="#06FFFFFF",
    btn_accent_a="#37e9e9",
    btn_accent_b="#16c3c3",
    btn_danger_a="#ff6b78",
    btn_danger_b="#e6394a",
    brand_a="#1b2a33",
    brand_b="#0d1216",
    screen_a="#0d1319",
    screen_b="#080b0f",
    grid="#0FFFFFFF",
    grid_ink="#6d7b8e",
    rail_a="#F012171F",
    rail_b="#F50A0D12",
    topbar_bg="#C70A0D12",
    legend_bg="#99080B0F",
    toast_bg="#F5141922",
    ch=("#2ee6e6", "#f5b544", "#a78bfa", "#3ddc84", "#6ea8fe", "#ff8fab", "#9ae6b4"),
)

LIGHT = Theme(
    name="light",
    bg="#eef2f7",
    bg_grad_a="#e7eef7",
    bg_grad_b="#f5f8fb",
    surface="#ffffff",
    surface_2="#ffffff",
    surface_3="#f6f9fc",
    inset="#f1f5f9",
    line="#d9e1ea",
    line_soft="#e6ecf3",
    line_strong="#c3cddb",
    text="#131c26",
    text_2="#445364",
    text_3="#6c7b8d",
    text_4="#909daf",
    accent="#0a97a3",
    accent_dim="#0b7c87",
    accent_ink="#ffffff",
    accent_soft="#1A0A97A3",
    accent_line="#520A97A3",
    violet="#7c5cf0",
    blue="#2f6fe0",
    ok="#128a52",
    ok_soft="#1A128A52",
    warn="#a06a12",
    warn_soft="#1FA06A12",
    danger="#cf3143",
    danger_soft="#1ACF3143",
    raise_1="#ffffff",
    raise_2="#f2f6fa",
    raise_3="#f7fafd",
    raise_4="#e9eff6",
    fill_1="#0A101828",
    fill_2="#0F101828",
    fill_3="#08101828",
    btn_accent_a="#12b3be",
    btn_accent_b="#0a8f9a",
    btn_danger_a="#e5485a",
    btn_danger_b="#c62b3d",
    brand_a="#dff0f4",
    brand_b="#f3f7fb",
    screen_a="#f9fbfd",
    screen_b="#eef3f8",
    grid="#1A101828",
    grid_ink="#5b697a",
    rail_a="#F0FFFFFF",
    rail_b="#F5F6F9FC",
    topbar_bg="#CCFFFFFF",
    legend_bg="#D9F1F5F9",
    toast_bg="#F7FFFFFF",
    ch=("#0a97a3", "#b3760f", "#6d4fd8", "#128a52", "#2f6fe0", "#c53f6a", "#4c8a5e"),
)


def qss(t: Theme) -> str:
    """Global style sheet.  Widget variants are selected through properties."""
    return f"""
    QWidget {{
        color: {t.text};
        font-size: 13px;
    }}
    QToolTip {{
        background: {t.surface_3};
        color: {t.text};
        border: 1px solid {t.line_strong};
        border-radius: 6px;
        padding: 5px 8px;
    }}
    QMainWindow, #root {{
        background: {t.bg};
    }}
    #rail {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.rail_a}, stop:1 {t.rail_b});
        border-right: 1px solid {t.line_soft};
    }}
    #topbar {{
        background: {t.topbar_bg};
        border-bottom: 1px solid {t.line_soft};
    }}
    #subbar {{
        background: {t.topbar_bg};
    }}
    #toolbar {{
        background: {t.surface};
        border-bottom: 1px solid {t.line};
    }}
    #brandMark {{
        background: qradialgradient(cx:0.3, cy:0.2, radius:1.2, fx:0.3, fy:0.2,
            stop:0 {t.brand_a}, stop:1 {t.brand_b});
        border: 1px solid {t.line};
        border-radius: 10px;
    }}
    QLabel {{
        background: transparent;
    }}
    QLabel#brandName {{
        font-size: 14px;
        font-weight: 650;
    }}
    QLabel#brandSub {{
        font-size: 10px;
        color: {t.text_3};
    }}
    QLabel#railGroup {{
        font-size: 9px;
        font-weight: 600;
        color: {t.text_4};
        padding: 12px 10px 5px;
    }}
    QLabel#pageTitle {{
        font-size: 17px;
        font-weight: 640;
    }}
    QLabel#pageDesc {{
        font-size: 11px;
        color: {t.text_3};
    }}
    QLabel#cardTitle {{
        font-size: 12.5px;
        font-weight: 620;
    }}
    QLabel#cardSub {{
        font-size: 9px;
        color: {t.text_4};
    }}
    QLabel#fieldLabel {{
        font-size: 10px;
        font-weight: 600;
        color: {t.text_4};
    }}
    QLabel#muted {{ color: {t.text_3}; }}
    QLabel#tiny {{ font-size: 10.5px; color: {t.text_3}; }}
    QLabel#mono {{ font-family: "Cascadia Code", Consolas; }}
    QLabel#crumb {{
        font-size: 11px;
        color: {t.text_4};
    }}
    QLabel#crumbBold {{
        font-size: 11px;
        color: {t.text_2};
        font-weight: 600;
    }}

    QFrame#card {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.surface_2}, stop:1 {t.surface});
        border: 1px solid {t.line};
        border-radius: 16px;
    }}
    QFrame#card:hover {{ border-color: {t.line_strong}; }}
    QFrame#divider {{ background: {t.line_soft}; max-height: 1px; min-height: 1px; border: none; }}
    QFrame#vdivider {{ background: {t.line_soft}; max-width: 1px; min-width: 1px; border: none; }}
    QFrame#stat {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.surface_2}, stop:1 {t.surface});
        border: 1px solid {t.line};
        border-radius: 16px;
    }}
    QFrame#notice {{
        background: {t.accent_soft};
        border: 1px solid {t.accent_line};
        border-radius: 10px;
    }}
    QFrame#noticeWarn {{
        background: {t.warn_soft};
        border: 1px solid #4CF5B544;
        border-radius: 10px;
    }}
    QFrame#noticeDanger {{
        background: {t.danger_soft};
        border: 1px solid #4CFF5F6D;
        border-radius: 10px;
    }}
    QFrame#toast {{
        background: {t.toast_bg};
        border: 1px solid {t.line_strong};
        border-radius: 12px;
    }}

    QPushButton {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.raise_1}, stop:1 {t.raise_2});
        border: 1px solid {t.line};
        border-radius: 9px;
        padding: 7px 13px;
        font-size: 12px;
        font-weight: 550;
        color: {t.text};
    }}
    QPushButton:hover {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.raise_3}, stop:1 {t.raise_4});
        border-color: {t.line_strong};
    }}
    QPushButton:pressed {{ background: {t.raise_4}; }}
    QPushButton:disabled {{ color: {t.text_4}; border-color: {t.line_soft}; background: {t.surface}; }}
    QPushButton[variant="primary"] {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.btn_accent_a}, stop:1 {t.btn_accent_b});
        border-color: {t.btn_accent_a};
        color: {t.accent_ink};
        font-weight: 650;
    }}
    QPushButton[variant="primary"]:hover {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.accent}, stop:1 {t.accent_dim});
    }}
    QPushButton[variant="danger"] {{
        background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {t.btn_danger_a}, stop:1 {t.btn_danger_b});
        border-color: {t.danger};
        color: #ffffff;
        font-weight: 650;
    }}
    QPushButton[variant="ghost"] {{
        background: transparent;
        border-color: {t.line};
    }}
    QPushButton[variant="ghost"]:hover {{ background: {t.fill_1}; border-color: {t.line_strong}; }}
    QPushButton[size="sm"] {{
        padding: 4px 9px;
        font-size: 11px;
        border-radius: 6px;
    }}
    QPushButton#navItem {{
        background: transparent;
        border: none;
        border-radius: 9px;
        padding: 8px 10px;
        text-align: left;
        color: {t.text_2};
        font-size: 12.5px;
        font-weight: 500;
    }}
    QPushButton#navItem:hover {{ background: {t.fill_1}; color: {t.text}; }}
    QPushButton#navItem:checked {{
        background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
            stop:0 #242EE6E6, stop:1 #052EE6E6);
        color: {t.text};
        border-left: 2px solid {t.accent};
        padding-left: 8px;
    }}
    QPushButton#navItem:checked {{ color: {t.text}; }}

    QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox {{
        background: {t.inset};
        border: 1px solid {t.line};
        border-radius: 9px;
        padding: 7px 10px;
        font-family: "Cascadia Code", Consolas;
        font-size: 12px;
        selection-background-color: {t.accent_dim};
        color: {t.text};
    }}
    QLineEdit:hover, QSpinBox:hover, QDoubleSpinBox:hover, QComboBox:hover {{ border-color: {t.line_strong}; }}
    QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus {{
        border-color: {t.accent_line};
    }}
    QLineEdit:disabled, QSpinBox:disabled, QDoubleSpinBox:disabled, QComboBox:disabled {{
        color: {t.text_4};
        background: {t.surface_2};
    }}
    QSpinBox::up-button, QDoubleSpinBox::up-button,
    QSpinBox::down-button, QDoubleSpinBox::down-button {{
        width: 0px;
        border: none;
    }}
    QComboBox::drop-down {{ border: none; width: 22px; }}
    QComboBox QAbstractItemView {{
        background: {t.surface_3};
        border: 1px solid {t.line_strong};
        border-radius: 8px;
        selection-background-color: {t.accent_soft};
        selection-color: {t.text};
        outline: none;
        padding: 4px;
    }}

    QCheckBox {{ spacing: 7px; font-size: 12px; color: {t.text_2}; }}
    QCheckBox::indicator {{
        width: 15px; height: 15px; border-radius: 4px;
        border: 1px solid {t.line_strong}; background: {t.inset};
    }}
    QCheckBox::indicator:checked {{ background: {t.accent}; border-color: {t.accent}; }}

    QScrollArea {{ background: transparent; border: none; }}
    QScrollArea > QWidget > QWidget {{ background: transparent; }}
    QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0; }}
    QScrollBar::handle:vertical {{
        background: {t.line_strong};
        border-radius: 4px;
        min-height: 30px;
        margin: 2px;
    }}
    QScrollBar::handle:vertical:hover {{ background: #3b4859; }}
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
    QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
    QScrollBar:horizontal {{ background: transparent; height: 10px; }}
    QScrollBar::handle:horizontal {{
        background: {t.line_strong}; border-radius: 4px; min-width: 30px; margin: 2px;
    }}
    QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{ width: 0; }}
    QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{ background: transparent; }}

    QPlainTextEdit, QTextEdit {{
        background: {t.inset};
        border: 1px solid {t.line};
        border-radius: 10px;
        color: {t.text_2};
        font-family: "Cascadia Code", Consolas;
        font-size: 11.5px;
        padding: 8px;
    }}

    QTableWidget, QTableWidget::item, QTableView {{
        background: transparent;
        border: none;
        gridline-color: {t.line_soft};
        selection-background-color: {t.accent_soft};
        selection-color: {t.text};
    }}
    QHeaderView::section {{
        background: transparent;
        color: {t.text_3};
        border: none;
        border-bottom: 1px solid {t.line_soft};
        padding: 7px 6px;
        font-size: 11px;
        text-align: left;
    }}
    QTableWidget::item {{ border-bottom: 1px solid {t.line_soft}; padding: 6px; }}
    QTableCornerButton::section {{ background: transparent; border: none; }}

    QDialog {{ background: {t.bg}; }}
    QToolButton {{ background: transparent; border: none; }}
    QToolButton:hover {{ background: {t.fill_1}; border-radius: 6px; }}

    QMenu {{
        background: {t.surface_3};
        border: 1px solid {t.line_strong};
        border-radius: 8px;
        padding: 5px;
    }}
    QMenu::item {{ padding: 6px 18px; border-radius: 5px; }}
    QMenu::item:selected {{ background: {t.accent_soft}; }}

    QLabel#kvKey {{ color: {t.text_3}; font-size: 11.5px; }}
    QLabel#kvValue {{ color: {t.text}; font-family: "Cascadia Code", Consolas; font-size: 11px; }}
    QLabel#statLabel {{ color: {t.text_4}; font-size: 10px; font-weight: 600; }}
    QLabel#statValue {{ color: {t.text}; font-family: "Cascadia Code", Consolas; font-size: 24px; }}
    QLabel#statUnit {{ color: {t.text_3}; font-size: 11px; }}
    QLabel#statDelta {{ color: {t.text_3}; font-size: 10.5px; }}
    QLabel#noticeText {{ color: {t.text_2}; font-size: 11.5px; }}
    QLabel#stepIndex {{ color: {t.text_4}; font-family: "Cascadia Code", Consolas; font-size: 10px; }}
    QLabel#stepLabel {{ color: {t.text_2}; font-size: 11.5px; }}
    QLabel#stepLabel[finished="true"] {{ color: {t.text}; }}
    QLabel#stepDetail {{ color: {t.text_3}; font-size: 10px; font-family: "Cascadia Code", Consolas; }}
    QLabel#stepEmpty {{ color: {t.text_4}; font-size: 11px; padding: 4px 2px; }}
    QLabel#toastText {{ color: {t.text}; font-size: 11.5px; }}
    QLabel#mutedTiny {{ color: {t.text_3}; font-size: 10.5px; }}
    QLabel#hintText {{ color: {t.text_4}; font-size: 9.5px; }}

    QFrame#badge {{ border-radius: 11px; }}
    QFrame#badge[tone="neutral"] {{ background: {t.fill_2}; border: 1px solid {t.line}; }}
    QFrame#badge[tone="ok"] {{ background: {t.ok_soft}; border: 1px solid {alpha(t.ok, 70)}; }}
    QFrame#badge[tone="warn"] {{ background: {t.warn_soft}; border: 1px solid {alpha(t.warn, 70)}; }}
    QFrame#badge[tone="danger"] {{ background: {t.danger_soft}; border: 1px solid {alpha(t.danger, 75)}; }}
    QFrame#badge[tone="accent"] {{ background: {t.accent_soft}; border: 1px solid {t.accent_line}; }}
    QLabel#badgeText {{ font-size: 10.5px; font-weight: 600; background: transparent; }}
    QFrame#badge[tone="neutral"] QLabel#badgeText {{ color: {t.text_2}; }}
    QFrame#badge[tone="ok"] QLabel#badgeText {{ color: {t.ok}; }}
    QFrame#badge[tone="warn"] QLabel#badgeText {{ color: {t.warn}; }}
    QFrame#badge[tone="danger"] QLabel#badgeText {{ color: {t.danger}; }}
    QFrame#badge[tone="accent"] QLabel#badgeText {{ color: {t.accent}; }}
    """


THEMES = {"dark": DARK, "light": LIGHT}

# The active theme, kept in sync by MainWindow.apply_theme.  Widgets use it for
# the few inline styles that QSS cannot express (painted text, tonal badges).
ACTIVE: Theme = DARK


def current() -> Theme:
    return ACTIVE


def set_active(theme: Theme) -> None:
    global ACTIVE
    ACTIVE = theme


def alpha(color: str, a: int) -> str:
    """Return a Qt #AARRGGBB string for a 6-digit colour."""
    c = QColor(color)
    return f"#{a:02X}{c.red():02X}{c.green():02X}{c.blue():02X}"
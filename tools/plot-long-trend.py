#!/usr/bin/env python3
"""Plot preregistered long-trend books; never calculate or fit a strategy.

Usage:
  python tools/plot-long-trend.py --input books.json --output validation.png
  python tools/plot-long-trend.py --input books.json --output validation.svg
"""

import argparse
import json
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, MaxNLocator


STYLES = {
    "v3": ("v3", "#7C8798", 1.9, (0, (5, 2))),
    "long_trend_200": ("SMA200 · 3 cierres", "#3156CF", 2.6, "-"),
    "buy_hold": ("Comprar y mantener", "#138678", 2.3, "-"),
}
MONTHS = ("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")


def number(value, decimals=2):
    return f"{value:,.{decimals}f}".replace(",", "_").replace(".", ",").replace("_", ".")


def day_label(value):
    date = datetime.fromisoformat(value)
    return f"{date.day} {MONTHS[date.month - 1]} {date.year}"


def spaced_labels(final_values, low, high):
    """Separate end labels without moving the data or hiding differences."""
    ordered = sorted(final_values, key=final_values.get)
    minimum_gap = (high - low) * 0.12
    positions = {}
    for index, strategy in enumerate(ordered):
        positions[strategy] = max(final_values[strategy],
                                  positions[ordered[index - 1]] + minimum_gap if index else low)
    overflow = max(positions.values()) - (high - (high - low) * 0.04)
    if overflow > 0:
        positions = {strategy: value - overflow for strategy, value in positions.items()}
    return positions


def render(report, output):
    main = report
    settings = main["long_trend_200"]["options"]
    expected = {"initialCapital": 100000, "commissionBps": 0, "slippageBps": 5, "warmupBars": 202}
    for strategy in STYLES:
        book = main[strategy]
        if any(book["options"].get(key) != value for key, value in expected.items()):
            raise ValueError("El gráfico principal requiere US$100.000, comisión cero, 5 pb y 202 barras comunes.")
        if len(book["perTicker"]) != 250:
            raise ValueError("El gráfico principal requiere las 250 asignaciones del universo registrado.")
        if book["period"]["startDate"] != "2008-01-02" or book["period"]["endDate"] != "2015-12-31":
            raise ValueError("El gráfico principal requiere el período reservado 2008–2015.")
    aligned_dates = [row["date"] for row in main["v3"]["equityCurve"]]
    if any([row["date"] for row in main[strategy]["equityCurve"]] != aligned_dates for strategy in STYLES):
        raise ValueError("Las curvas no comparten exactamente las mismas fechas.")
    if any(not main[strategy]["equityCurve"] for strategy in STYLES):
        raise ValueError("Falta una curva de capital en los resultados guardados.")
    period = main["long_trend_200"]["period"]
    start = datetime.fromisoformat(period["startDate"])
    end = datetime.fromisoformat(period["endDate"])
    initial_capital = settings["initialCapital"]
    ticker_count = len(main["long_trend_200"]["perTicker"])

    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 10.5,
        "axes.labelcolor": "#334155", "text.color": "#172B4D",
        "xtick.color": "#586779", "ytick.color": "#586779",
        "axes.edgecolor": "#D7DFE8", "axes.spines.top": False,
        "axes.spines.right": False, "axes.spines.left": False,
        "svg.fonttype": "none", "svg.hashsalt": "market-scanner-long-trend-validation",
        "savefig.facecolor": "#FFFFFF",
    })
    fig, (capital_ax, drawdown_ax) = plt.subplots(
        2, 1, figsize=(14.4, 9.4), sharex=True,
        gridspec_kw={"height_ratios": [1.7, 1], "hspace": 0.29},
    )
    fig.subplots_adjust(left=0.085, right=0.79, top=0.79, bottom=0.205)
    fig.text(0.085, 0.947, "Ventas al perder la tendencia de largo plazo", fontsize=23, weight="bold")
    fig.text(0.085, 0.906,
             f"{day_label(period['startDate'])} – {day_label(period['endDate'])}  ·  "
             f"{ticker_count} asignaciones  ·  Capital inicial US${number(initial_capital, 0)}",
             fontsize=11.5, color="#586779")

    handles, final_values = {}, {}
    all_equities = [initial_capital]
    min_drawdown = 0
    for strategy in ("buy_hold", "v3", "long_trend_200"):
        label, color, width, linestyle = STYLES[strategy]
        rows = main[strategy]["equityCurve"]
        dates = [datetime.fromisoformat(row["date"]) for row in rows]
        equities = [row["equity"] for row in rows]
        drawdowns = [100 * row["drawdown"] for row in rows]
        all_equities.extend(equities)
        min_drawdown = min(min_drawdown, min(drawdowns))
        (handles[strategy],) = capital_ax.plot(dates, equities, color=color, lw=width,
                                               linestyle=linestyle, label=label, zorder=3)
        drawdown_ax.plot(dates, drawdowns, color=color, lw=width - 0.3,
                         linestyle=linestyle, zorder=3)
        final_values[strategy] = equities[-1]
        capital_ax.plot(dates[-1], equities[-1], "o", color=color, ms=4, clip_on=False)
        low_index = min(range(len(drawdowns)), key=drawdowns.__getitem__)
        drawdown_ax.plot(dates[low_index], drawdowns[low_index], "o", color=color, ms=4, zorder=4)

    capital_low = min(all_equities) * 0.94
    capital_high = max(all_equities) * 1.07
    if capital_high <= capital_low:
        capital_high = capital_low + 1
    label_positions = spaced_labels(final_values, capital_low, capital_high)
    for strategy, value in final_values.items():
        label, color, *_ = STYLES[strategy]
        final_label = (f"{label}\nUS${number(value, 0)}  ·  "
                       f"{number(main[strategy]['metrics']['totalReturn'] * 100)}%")
        # Text uses axes-fraction x and data y, so labels remain aligned in the
        # right margin while light connectors preserve each exact endpoint.
        capital_ax.annotate(final_label, xy=(end, value), xycoords="data",
                            xytext=(1.025, label_positions[strategy]),
                            textcoords=("axes fraction", "data"), color=color,
                            fontsize=10.5, weight="bold", va="center",
                            annotation_clip=False, linespacing=1.5,
                            arrowprops={"arrowstyle": "-", "color": color, "lw": 0.7,
                                        "shrinkA": 4, "shrinkB": 5})

    fig.legend([handles[strategy] for strategy in STYLES],
               [STYLES[strategy][0] for strategy in STYLES],
               loc="upper left", bbox_to_anchor=(0.079, 0.867), ncol=3,
               frameon=False, columnspacing=3.0, handlelength=3.1)
    capital_ax.set_title("Capital acumulado, neto de costes", loc="left", fontsize=12, weight="bold", pad=13)
    capital_ax.axhline(initial_capital, lw=0.8, color="#D8E0E9", zorder=1)
    capital_ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"${number(value / 1000, 0)} mil"))
    capital_ax.yaxis.set_major_locator(MaxNLocator(nbins=6, min_n_ticks=4))
    capital_ax.set_ylim(capital_low, capital_high)
    capital_ax.tick_params(axis="x", bottom=False, labelbottom=False)

    drawdown_ax.set_title("Caída desde el máximo anterior", loc="left", fontsize=12, weight="bold", pad=13)
    drawdown_ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{number(value, 0)}%"))
    drawdown_ax.yaxis.set_major_locator(MaxNLocator(nbins=5, min_n_ticks=3))
    drawdown_ax.set_ylim(min(min_drawdown * 1.12, -1), 1)
    drawdown_ax.axhline(0, lw=0.8, color="#D8E0E9", zorder=1)
    drawdown_ax.xaxis.set_major_locator(mdates.YearLocator())
    drawdown_ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    for axis in (capital_ax, drawdown_ax):
        axis.grid(axis="y", color="#E6EBF1", linewidth=0.8)
        axis.set_axisbelow(True)
        axis.tick_params(axis="both", length=0, pad=9)
        axis.set_xlim(start, end)

    drawdown_ax.text(1.025, 0.98, "CAÍDA MÁXIMA", transform=drawdown_ax.transAxes,
                     color="#586779", fontsize=9.5, weight="bold", va="top")
    for index, strategy in enumerate(STYLES):
        label, color, *_ = STYLES[strategy]
        drawdown_ax.text(1.025, 0.77 - index * 0.27,
                         f"{label}\n{number(main[strategy]['metrics']['maxDrawdown'] * 100)}%",
                         transform=drawdown_ax.transAxes, color=color,
                         fontsize=10.5, va="top", linespacing=1.5)

    commission = "US$0" if settings["commissionBps"] == 0 else f"{number(settings['commissionBps'] / 100)}%"
    slippage = settings["slippageBps"]
    fig.text(0.085, 0.132,
             f"Comisión {commission} · Deslizamiento {number(slippage, 0)} pb ({number(slippage / 100)}%) por compra y venta · "
             "Apertura siguiente a la señal.", fontsize=10, color="#475569")
    fig.text(0.085, 0.105,
             "Señales con OHLC originales; rentabilidad con OHLC ajustados, como aproximación a dividendos reinvertidos.",
             fontsize=9.5, color="#475569")
    universe_year = "2026"
    fig.text(0.085, 0.069,
             f"Universo seleccionado en {universe_year}. Datos revisados y selección retrospectiva. "
             "Período histórico reservado; no es validación prospectiva.",
             fontsize=9.5, color="#697586")
    fig.text(0.085, 0.044,
             "202 barras previas para las tres estrategias; efectivo sin intereses; asignación inicial igual y liquidación final con costes.",
             fontsize=9.5, color="#697586")
    output.parent.mkdir(parents=True, exist_ok=True)
    metadata = {"Creator": "Market Scanner · plot-long-trend.py"}
    if output.suffix.lower() == ".svg":
        metadata["Date"] = None
    fig.savefig(output, dpi=180, metadata=metadata)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.suffix.lower() not in {".png", ".svg"}:
        parser.error("--output debe terminar en .png o .svg")
    report = json.loads(args.input.read_text(encoding="utf-8"))
    render(report, args.output)
    print(f"Gráfico guardado: {args.output.resolve()}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Render the reproducible backtest report using matplotlib and the standard library.

Usage:
  python tools/plot-backtest.py --input /path/results.json --output /path/backtest.png
  python tools/plot-backtest.py --input /path/results.json --output /path/backtest.svg
"""

import argparse
import json
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, MultipleLocator


STYLES = {
    "new": ("Lógica nueva", "#3454D1", 2.7, "-"),
    "old": ("Lógica anterior", "#697586", 2.1, (0, (5, 2))),
    "buy_hold": ("Comprar y mantener", "#138678", 2.3, "-"),
}
MONTHS = ("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")


def number(value, decimals=2):
    return f"{value:,.{decimals}f}".replace(",", "_").replace(".", ",").replace("_", ".")


def day_label(value):
    date = datetime.fromisoformat(value)
    return f"{date.day} {MONTHS[date.month - 1]} {date.year}"


def date_tick(value, _position):
    date = mdates.num2date(value)
    return f"{MONTHS[date.month - 1]} {date.year}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.suffix.lower() not in {".png", ".svg", ".pdf"}:
        parser.error("--output debe terminar en .png, .svg o .pdf")
    report = json.loads(args.input.read_text(encoding="utf-8"))
    main_results = report["main"]
    settings = report["settings"]
    for strategy in STYLES:
        if not main_results[strategy]["equityCurve"]:
            parser.error(f"No hay curva de capital para {strategy}")
    period = main_results["new"]["period"]
    start = datetime.fromisoformat(period["startDate"])
    end = datetime.fromisoformat(period["endDate"])
    initial_capital = settings["initialCapital"]
    ticker_count = len(report["perTicker"])

    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 10.5,
        "axes.labelcolor": "#334155", "text.color": "#172B4D",
        "xtick.color": "#586779", "ytick.color": "#586779",
        "axes.edgecolor": "#D7DFE8", "axes.spines.top": False,
        "axes.spines.right": False, "axes.spines.left": False,
        "svg.fonttype": "none", "svg.hashsalt": "market-scanner-backtest",
        "savefig.facecolor": "#FFFFFF",
    })
    fig, (capital_ax, drawdown_ax) = plt.subplots(
        2, 1, figsize=(14.4, 9.4), sharex=True,
        gridspec_kw={"height_ratios": [1.7, 1], "hspace": 0.26},
    )
    fig.subplots_adjust(left=0.08, right=0.80, top=0.80, bottom=0.17)
    fig.text(0.08, 0.945, "Backtest del Market Scanner", fontsize=24, weight="bold")
    fig.text(0.08, 0.905,
             f"{day_label(period['startDate'])} – {day_label(period['endDate'])}  ·  "
             f"{ticker_count} instrumentos  ·  Capital inicial US${number(initial_capital, 0)}",
             fontsize=11.5, color="#586779")

    handles = {}
    all_equities = [initial_capital]
    min_drawdown = 0
    for strategy in ("buy_hold", "old", "new"):
        label, color, linewidth, linestyle = STYLES[strategy]
        result = main_results[strategy]
        rows = result["equityCurve"]
        dates = [datetime.fromisoformat(row["date"]) for row in rows]
        equities = [row["equity"] for row in rows]
        drawdowns = [100 * row["drawdown"] for row in rows]
        all_equities.extend(equities)
        min_drawdown = min(min_drawdown, min(drawdowns))
        (handle,) = capital_ax.plot(dates, equities, color=color, lw=linewidth,
                                    linestyle=linestyle, label=label, zorder=3)
        handles[strategy] = handle
        drawdown_ax.plot(dates, drawdowns, color=color, lw=linewidth - 0.3,
                         linestyle=linestyle, zorder=3)
        capital_ax.plot(dates[-1], equities[-1], "o", color=color, ms=4, clip_on=False)
        final_label = (f"US${number(equities[-1])}\n"
                       f"{number(result['metrics']['totalReturnPct'])}% neto")
        capital_ax.annotate(final_label, (dates[-1], equities[-1]),
                            xytext=(13, 0), textcoords="offset points",
                            color=color, fontsize=11, weight="bold",
                            va="center", annotation_clip=False, linespacing=1.5)
        low_index = min(range(len(drawdowns)), key=drawdowns.__getitem__)
        drawdown_ax.plot(dates[low_index], drawdowns[low_index], "o",
                         color=color, ms=4.5, zorder=4)

    fig.legend([handles[strategy] for strategy in STYLES],
               [STYLES[strategy][0] for strategy in STYLES],
               loc="upper left", bbox_to_anchor=(0.074, 0.868),
               ncol=3, frameon=False, columnspacing=2.7, handlelength=3.2)
    capital_ax.set_title("Capital acumulado", loc="left", fontsize=12, weight="bold", pad=13)
    capital_ax.axhline(initial_capital, lw=0.8, color="#D8E0E9", zorder=1)
    capital_ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"${number(value / 1000, 0)} mil"))
    capital_ax.yaxis.set_major_locator(MultipleLocator(25000))
    capital_ax.set_ylim(min(all_equities) * 0.95, max(all_equities) * 1.035)
    capital_ax.tick_params(axis="x", bottom=False, labelbottom=False)

    drawdown_ax.set_title("Caída desde el máximo anterior", loc="left", fontsize=12, weight="bold", pad=13)
    drawdown_ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{number(value, 0)}%"))
    drawdown_ax.yaxis.set_major_locator(MultipleLocator(5))
    drawdown_ax.set_ylim(min_drawdown * 1.14, 0.8)
    drawdown_ax.axhline(0, lw=0.8, color="#D8E0E9", zorder=1)
    drawdown_ax.xaxis.set_major_locator(mdates.MonthLocator(bymonth=[1, 4, 7, 10]))
    drawdown_ax.xaxis.set_major_formatter(FuncFormatter(date_tick))
    for axis in (capital_ax, drawdown_ax):
        axis.grid(axis="y", color="#E6EBF1", linewidth=0.8)
        axis.set_axisbelow(True)
        axis.tick_params(axis="both", length=0, pad=9)
        axis.set_xlim(start, end)

    drawdown_ax.text(1.02, 0.95, "CAÍDA MÁXIMA", transform=drawdown_ax.transAxes,
                     color="#586779", fontsize=9.5, weight="bold", va="top")
    for index, strategy in enumerate(STYLES):
        label, color, *_ = STYLES[strategy]
        drawdown_ax.text(1.02, 0.75 - index * 0.27,
                         f"{label}\n{number(main_results[strategy]['metrics']['maxDrawdownPct'])}%",
                         transform=drawdown_ax.transAxes, color=color,
                         fontsize=10.5, va="top", linespacing=1.5)

    commission = "US$0" if settings["commissionBps"] == 0 else f"{number(settings['commissionBps'] / 100)}%"
    slippage = number(settings["slippageBps"] / 100)
    fig.text(0.08, 0.104,
             f"Comisión {commission} · Deslizamiento {slippage}% por compra y por venta · "
             "Señal al cierre; ejecución en la siguiente apertura.", fontsize=10, color="#475569")
    fig.text(0.08, 0.079,
             "Asignación inicial igual por instrumento, sin rebalanceo. Efectivo sin intereses. "
             "Liquidación final con costes.", fontsize=10, color="#475569")
    fig.text(0.08, 0.046,
             "Evaluación retrospectiva de precios, sin dividendos. Universo seleccionado en octubre de 2026; "
             "no es una prueba fuera de muestra.", fontsize=9.5, color="#697586")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    metadata = {"Creator": "Market Scanner · plot-backtest.py"}
    if args.output.suffix.lower() == ".svg":
        metadata["Date"] = None
    fig.savefig(args.output, dpi=180, metadata=metadata)
    plt.close(fig)
    print(f"Gráfico guardado: {args.output.resolve()}")


if __name__ == "__main__":
    main()

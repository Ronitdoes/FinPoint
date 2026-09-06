"use client";

import React from "react";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  icon?: React.ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  activeTab: string;
  onChange: (tabId: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onChange, className = "" }: TabsProps) {
  return (
    <div
      className={`inline-flex items-center p-1 rounded-2xl bg-white/[0.04] backdrop-blur-xl border border-white/10 gap-1 overflow-x-auto ${className}`}
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={`group relative inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-xl transition-[transform,background-color,border-color,color] duration-150 cursor-pointer whitespace-nowrap ${
              isActive
                ? "bg-white/[0.09] text-white border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] backdrop-blur-md"
                : "text-slate-400 hover:text-white hover:bg-white/[0.06] border border-transparent"
            }`}
          >
            {tab.icon && (
              <span className={`shrink-0 ${isActive ? "text-white" : "text-slate-400 group-hover:text-slate-200"}`}>
                {tab.icon}
              </span>
            )}
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold tracking-wide ${
                  isActive
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    : "bg-slate-800/80 text-slate-400 group-hover:bg-slate-700"
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

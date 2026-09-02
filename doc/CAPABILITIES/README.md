# Capability matrix

This lists every ABAP object type abapsmith has a registry entry for, every
framework it reaches, and every non-object capability, with what it can and
cannot do to each. The object-type table is derived mechanically from
`src/adt/capabilities.ts` and `src/adt/types.ts`; the framework and
non-object tables are hand-maintained — only their shape is machine-checked,
not their content.

| File | Contents |
| --- | --- |
| [legend.md](legend.md) | Capability and evidence markers, and the column convention every table below uses |
| [object-types.md](object-types.md) | How object rows are derived, the full object-type table, and per-row notes |
| [bopf.md](bopf.md) | BOPF business objects, nodes, associations, actions, determinations, validations, queries, keys |
| [cds.md](cds.md) | CDS view and metadata extension support |
| [rap.md](rap.md) | RAP: behavior definitions, service definitions and bindings, OData metadata, draft handling |
| [fpm-fbi.md](fpm-fbi.md) | FPM/FBI configuration read support |
| [non-object-capabilities.md](non-object-capabilities.md) | Debugger, ABAP Unit, ATC, transports, activation, journal/undo, search, data preview, UI automation |
| [absent-entirely.md](absent-entirely.md) | Things a reader might expect and will not find here |

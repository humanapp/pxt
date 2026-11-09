/// <reference path="../../built/pxtlib.d.ts" />

import * as Blockly from "blockly";
import { FieldDropdown } from "./field_dropdown";
import { FieldCustom, FieldCustomDropdownOptions } from "./field_utils";
import { getFixedInstanceDropdownOptions } from "./symbolDropdownOptions";

/** The field editor id of `FieldInstanceDropdown`. */
export const INSTANCE_DROPDOWN_FIELD = "instancedropdown";

/**
 * The start of the value of each entry of the dropdown of a fixed-instance
 * parameter that asks for a new instance of the type, followed by the id of
 * the creator it asks. It is not a qualified name, so such a value never
 * equals the value of an instance.
 */
export const CREATE_INSTANCE_OPTION_VALUE = "@createinstance@";

/**
 * The value of the entry of the dropdown of a fixed-instance parameter that
 * asks to edit the instance the field holds. It is not a qualified name, so it
 * never equals the value of an instance.
 */
export const OPEN_INSTANCE_OPTION_VALUE = "@openinstance@";

/**
 * The value of the entry of the dropdown of a fixed-instance parameter that
 * says the type has no instances yet, listed alone when there are none and no
 * other entry is offered. It is not a qualified name, so it never equals the
 * value of an instance.
 */
export const NO_INSTANCE_OPTION_VALUE = "@noinstance@";

/**
 * Returns true if `value` is one of the values the dropdown of a fixed-instance
 * parameter gives its entries that are not instances: one starting with
 * `CREATE_INSTANCE_OPTION_VALUE`, or `OPEN_INSTANCE_OPTION_VALUE` or
 * `NO_INSTANCE_OPTION_VALUE` itself.
 */
export function isReservedInstanceValue(value: string): boolean {
    return value.indexOf(CREATE_INSTANCE_OPTION_VALUE) === 0 || value === OPEN_INSTANCE_OPTION_VALUE || value === NO_INSTANCE_OPTION_VALUE;
}

/**
 * Returns the options of a fixed-instance dropdown: the instances, then, after
 * a separator, the edit entry (`OPEN_INSTANCE_OPTION_VALUE`) and one create
 * entry per `creates` pair, valued `CREATE_INSTANCE_OPTION_VALUE` followed by
 * the creator id. With no instances and no entry it returns the one
 * `emptyText` entry, valued `NO_INSTANCE_OPTION_VALUE`.
 * @param instances the options of the type's instances
 * @param editText the edit entry's text; undefined when the editor cannot open the instance here
 * @param creates the text and creator id of each create entry, in order
 * @param emptyText the text of the entry saying the type has no instances yet
 */
export function getInstanceDropdownOptions(instances: Blockly.MenuOption[], editText: string | undefined, creates: [string, string][], emptyText: string): Blockly.MenuOption[] {
    const commands: Blockly.MenuOption[] = [];
    if (editText !== undefined) commands.push([editText, OPEN_INSTANCE_OPTION_VALUE]);
    for (const [text, id] of creates) commands.push([text, CREATE_INSTANCE_OPTION_VALUE + id]);
    if (!commands.length) return instances.length ? instances.slice() : [[emptyText, NO_INSTANCE_OPTION_VALUE]];
    return instances.length ? [...instances, Blockly.FieldDropdown.SEPARATOR, ...commands] : commands;
}

/**
 * The dropdown of a fixed-instance parameter whose instances an editor tab can
 * create. Each time it opens it lists the type's instances from the current
 * API info, then an edit entry while `pxt.react.canOpenInstance` allows it and
 * one create entry per creator `pxt.react.getInstanceCreators` returns.
 * Picking an entry keeps the field's value and calls `pxt.react.openInstance`
 * or `pxt.react.createInstance`. While the type has no instances the value is
 * a reserved marker (see `isReservedInstanceValue`), which the blocks compiler
 * reports and compiles as `null`. Options: `data` (the instances' options),
 * `type`, `blocksInfo`, `getBlocksInfo` (the current API info), `defaultValue`.
 * pxtservices/simulator-extensions.md describes the entries.
 */
export class FieldInstanceDropdown extends FieldDropdown implements FieldCustom {
    public isFieldCustom_ = true;
    // the fully qualified name of the fixed-instance type the field picks an instance of
    protected typeQName: string;

    constructor(text: string, options: FieldCustomDropdownOptions, validator?: Blockly.FieldValidator) {
        super(createMenuGenerator(options, getTypeName(options.blocksInfo, options.type), new pxt.ImageConverter()), validator);
        this.typeQName = options.type;
    }

    protected onItemSelected_(menu: Blockly.Menu, menuItem: Blockly.MenuItem) {
        const value = menuItem.getValue();
        if (value.indexOf(CREATE_INSTANCE_OPTION_VALUE) === 0)
            pxt.react.createInstance?.(this.typeQName, value.slice(CREATE_INSTANCE_OPTION_VALUE.length));
        else if (value === OPEN_INSTANCE_OPTION_VALUE)
            pxt.react.openInstance?.(this.getValue());
        else if (value !== NO_INSTANCE_OPTION_VALUE)
            super.onItemSelected_(menu, menuItem);
    }
}

// Lists the options of the type's instances, built with `imgConv` from the
// API info `getBlocksInfo` returns, else `data`, then the entry asking to edit
// the instance the field holds, while the editor can open it, and one entry
// asking for a new instance per creator of the type's instances, or, with none
// of these to list, the entry saying the type has no instances yet, all read
// each time the dropdown opens.
function createMenuGenerator(options: FieldCustomDropdownOptions, typeName: string, imgConv: pxt.ImageConverter): Blockly.MenuGeneratorFunction {
    const { data, type: typeQName, getBlocksInfo, defaultValue } = options;
    return function (this: Blockly.FieldDropdown) {
        const blocksInfo = getBlocksInfo?.();
        const instances: Blockly.MenuOption[] = blocksInfo ? getFixedInstanceDropdownOptions(blocksInfo, typeQName, defaultValue, imgConv) : data;
        const value = this.getValue();
        const label = value && pxt.react.canOpenInstance?.(value) ? getInstanceLabel(instances, value) : undefined;
        const creators = pxt.react.getInstanceCreators?.(typeQName) || [];
        return getInstanceDropdownOptions(instances,
            label !== undefined ? lf("Edit {0}...", label) : undefined,
            creators.map(c => [creators.length === 1 ? lf("New {0}...", typeName) : lf("New {0} in {1}...", typeName, c.label), c.id] as [string, string]),
            lf("No {0} yet", typeName));
    };
}

// The label of the option among `instances` whose value is `value`: its text,
// or its image's alt text; undefined if no option has that value.
function getInstanceLabel(instances: Blockly.MenuOption[], value: string): string | undefined {
    for (const option of instances) {
        if (option === Blockly.FieldDropdown.SEPARATOR || option[1] !== value) continue;
        const label = option[0];
        return typeof label === "string" ? label : "alt" in label ? label.alt : undefined;
    }
    return undefined;
}

/**
 * Returns the name the dropdown of a fixed-instance parameter calls the type
 * by: the type's `block` attribute, else its unqualified name in lower case.
 * @param blocksInfo the API info that declares the type; undefined if none is available
 * @param typeQName the type's fully qualified name
 */
export function getTypeName(blocksInfo: pxtc.BlocksInfo | undefined, typeQName: string): string {
    const block = blocksInfo?.apis.byQName[typeQName]?.attributes.block;
    return block || typeQName.slice(typeQName.lastIndexOf(".") + 1).toLowerCase();
}

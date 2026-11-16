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
 * Takes a list of dropdown menu options and inserts the create, open, and empty placeholder
 * items as needed. Create and edit are added after the list of instances and a separator menu
 * item. There is one create item for each entry in `creates`, which pairs the item's text
 * with the id of the creator it asks.
 */
export function getInstanceDropdownOptions(instances: Blockly.MenuOption[], editText: string | undefined, creates: [string, string][], emptyText: string): Blockly.MenuOption[] {
    const commands: Blockly.MenuOption[] = [];
    if (editText !== undefined) commands.push([editText, OPEN_INSTANCE_OPTION_VALUE]);
    for (const [text, id] of creates) commands.push([text, CREATE_INSTANCE_OPTION_VALUE + id]);
    if (!commands.length) return instances.length ? instances.slice() : [[emptyText, NO_INSTANCE_OPTION_VALUE]];
    return instances.length ? [...instances, Blockly.FieldDropdown.SEPARATOR, ...commands] : commands;
}

/**
 * A field editor that provides a dropdown for selecting instances of a
 * type that has the fixedInstances annotation on it. This editor is intended
 * to be used with simx editor extensions that can emit instances of the
 * specified type in the user's project. For example, a song editor might
 * emit instances of a Track type to indicate the different songs that a
 * user has created within that simx editor.
 * 
 * This field editor also provides an optional pair of entry points into the simx
 * editor from within the dropdown, similar to how the variable dropdown allows
 * you to edit and create variables within the dropdown itself. These are checked using
 * `pxt.react.canOpenInstance`/`pxt.react.getInstanceCreators` and invoked using
 * `pxt.react.openInstance`/`pxt.react.createInstance` respectively. When more than
 * one simx editor can create the type, the dropdown lists a create item for each.
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

// Creates a function that returns a dynamic list of menu options
// based on the instances of the fixedInstance type in the current
// API info. Will also include placeholder options for creating new
// instances and editing existing instances if supported by the simx
// editor extension.
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

// Finds the display text for a given instance in the menu list. Used by the "edit instance"
// dropdown menu item.
function getInstanceLabel(instances: Blockly.MenuOption[], value: string): string | undefined {
    for (const option of instances) {
        if (option === Blockly.FieldDropdown.SEPARATOR || option[1] !== value) continue;
        const label = option[0];
        return typeof label === "string" ? label : "alt" in label ? label.alt : undefined;
    }
    return undefined;
}

// Finds the display name for the given fixedInstances type. Used by the "new instance"
// dropdown menu item.
export function getTypeName(blocksInfo: pxtc.BlocksInfo | undefined, typeQName: string): string {
    const block = blocksInfo?.apis.byQName[typeQName]?.attributes.block;
    return block || typeQName.slice(typeQName.lastIndexOf(".") + 1).toLowerCase();
}

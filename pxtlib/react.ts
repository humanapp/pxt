namespace pxt.react {
    export interface FieldEditorView<U> {
        show(): void;
        hide(): void;
        getResult(): U;
        onHide(cb: () => void): void;

        getPersistentData(): any;
        restorePersistentData(value: any): void;
    }

    export let isFieldEditorViewVisible: () => boolean;
    export let getFieldEditorView: <U>(fieldEditorId: string, value: U, options: any, container?: HTMLDivElement, keyboardTriggered?: boolean) => FieldEditorView<U>;
    export let getTilemapProject: () => TilemapProject;
    /**
     * Returns the creators of instances of the fixed-instance type `typeQName`,
     * a fully qualified name, here, empty when nothing can create one, in the
     * order a block dropdown lists them: each with the id `createInstance`
     * takes and the label the dropdown names it by.
     */
    export let getInstanceCreators: (typeQName: string) => { id: string, label: string }[];
    /**
     * Opens the creator `creatorId` of instances of the fixed-instance type
     * `typeQName`, one `getInstanceCreators` lists, and asks it to create one;
     * does nothing for any other id.
     */
    export let createInstance: (typeQName: string, creatorId: string) => void;
    /**
     * Returns true if the editor can open the fixed instance `instanceQName`, a
     * fully qualified name, here: a block dropdown holding the instance then
     * offers an entry asking to edit it.
     */
    export let canOpenInstance: (instanceQName: string) => boolean;
    /**
     * Opens whatever edits the fixed instance `instanceQName` and asks it to
     * open the instance; does nothing if `canOpenInstance` returns false for
     * the instance.
     */
    export let openInstance: (instanceQName: string) => void;
}
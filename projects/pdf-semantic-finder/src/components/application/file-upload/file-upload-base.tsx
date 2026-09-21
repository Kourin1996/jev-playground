import type { ComponentProps, ComponentPropsWithRef } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { FileIcon } from "@untitledui/file-icons";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import { CheckCircle, Trash01, UploadCloud02, XCircle } from "@untitledui/icons";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { cx } from "@/utils/cx";

/**
 * Returns a human-readable file size.
 * @param bytes - The size of the file in bytes.
 * @returns A string representing the file size in a human-readable format.
 */
export const getReadableFileSize = (bytes: number) => {
    if (bytes === 0) return "0 KB";

    const suffixes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

    const i = Math.floor(Math.log(bytes) / Math.log(1024));

    return Math.floor(bytes / Math.pow(1024, i)) + " " + suffixes[i];
};

interface FileUploadDropZoneProps {
    /** The class name of the drop zone. */
    className?: string;
    /**
     * A hint text explaining what files can be dropped.
     */
    hint?: string;
    /**
     * Disables dropping or uploading files.
     */
    isDisabled?: boolean;
    /**
     * Specifies the types of files that the server accepts.
     * Examples: "image/*", ".pdf,image/*", "image/*,video/mpeg,application/pdf"
     */
    accept?: string;
    /**
     * Allows multiple file uploads.
     */
    allowsMultiple?: boolean;
    /**
     * Maximum file size in bytes.
     */
    maxSize?: number;
    /**
     * Callback function that is called with the list of dropped files
     * when files are dropped on the drop zone.
     */
    onDropFiles?: (files: FileList) => void;
    /**
     * Callback function that is called with the list of unaccepted files
     * when files are dropped on the drop zone.
     */
    onDropUnacceptedFiles?: (files: FileList) => void;
    /**
     * Callback function that is called with the list of files that exceed
     * the size limit when files are dropped on the drop zone.
     */
    onSizeLimitExceed?: (files: FileList) => void;
}

export const FileUploadDropZone = ({
    className,
    hint,
    isDisabled,
    accept,
    allowsMultiple = true,
    maxSize,
    onDropFiles,
    onDropUnacceptedFiles,
    onSizeLimitExceed,
}: FileUploadDropZoneProps) => {
    const id = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [isInvalid, setIsInvalid] = useState(false);
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const [isFileOverWindow, setIsFileOverWindow] = useState(false);

    /**
     * Watches the whole window, not just the box.
     *
     * Two reasons. The box only learns about a drag once the pointer is already on it, so without
     * this it gives no sign that a dropped file would be accepted anywhere. And a file dropped
     * outside the box is otherwise handled by the browser, which navigates to it — in this
     * application that discards the open document and the current search.
     *
     * `dragenter` and `dragleave` fire in pairs as the pointer crosses child elements, so they are
     * counted rather than treated as a toggle.
     */
    useEffect(() => {
        if (isDisabled) return;

        let depth = 0;
        const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

        const onDragEnter = (event: DragEvent) => {
            if (!carriesFiles(event)) return;
            depth += 1;
            setIsFileOverWindow(true);
        };
        const onDragOver = (event: DragEvent) => {
            if (!carriesFiles(event)) return;
            // Required, or the browser refuses the drop and falls back to opening the file.
            event.preventDefault();
        };
        const onDragLeave = (event: DragEvent) => {
            if (!carriesFiles(event)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) setIsFileOverWindow(false);
        };
        const onDrop = (event: DragEvent) => {
            depth = 0;
            setIsFileOverWindow(false);
            // The box handles its own drop and stops propagation, so anything reaching the window
            // was dropped outside it. Swallowed rather than navigated to.
            if (carriesFiles(event)) event.preventDefault();
        };

        window.addEventListener("dragenter", onDragEnter);
        window.addEventListener("dragover", onDragOver);
        window.addEventListener("dragleave", onDragLeave);
        window.addEventListener("drop", onDrop);

        return () => {
            window.removeEventListener("dragenter", onDragEnter);
            window.removeEventListener("dragover", onDragOver);
            window.removeEventListener("dragleave", onDragLeave);
            window.removeEventListener("drop", onDrop);
        };
    }, [isDisabled]);

    const isFileTypeAccepted = (file: File): boolean => {
        if (!accept) return true;

        // Split the accept string into individual types
        const acceptedTypes = accept.split(",").map((type) => type.trim());

        return acceptedTypes.some((acceptedType) => {
            // Handle file extensions (e.g., .pdf, .doc)
            if (acceptedType.startsWith(".")) {
                const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
                return extension === acceptedType.toLowerCase();
            }

            // Handle wildcards (e.g., image/*)
            if (acceptedType.endsWith("/*")) {
                const typePrefix = acceptedType.split("/")[0];
                return file.type.startsWith(`${typePrefix}/`);
            }

            // Handle exact MIME types (e.g., application/pdf)
            return file.type === acceptedType;
        });
    };

    const handleDragIn = (event: React.DragEvent<HTMLLabelElement>) => {
        if (isDisabled) return;

        event.preventDefault();
        event.stopPropagation();
        setIsDraggingOver(true);
    };

    const handleDragOut = (event: React.DragEvent<HTMLLabelElement>) => {
        if (isDisabled) return;

        event.preventDefault();
        event.stopPropagation();
        setIsDraggingOver(false);
    };

    const processFiles = (files: File[]): void => {
        // Reset the invalid state when processing files.
        setIsInvalid(false);

        const acceptedFiles: File[] = [];
        const unacceptedFiles: File[] = [];
        const oversizedFiles: File[] = [];

        // If multiple files are not allowed, only process the first file
        const filesToProcess = allowsMultiple ? files : files.slice(0, 1);

        filesToProcess.forEach((file) => {
            // Check file size first
            if (maxSize && file.size > maxSize) {
                oversizedFiles.push(file);
                return;
            }

            // Then check file type
            if (isFileTypeAccepted(file)) {
                acceptedFiles.push(file);
            } else {
                unacceptedFiles.push(file);
            }
        });

        // Handle oversized files
        if (oversizedFiles.length > 0 && typeof onSizeLimitExceed === "function") {
            const dataTransfer = new DataTransfer();
            oversizedFiles.forEach((file) => dataTransfer.items.add(file));

            setIsInvalid(true);
            onSizeLimitExceed(dataTransfer.files);
        }

        // Handle accepted files
        if (acceptedFiles.length > 0 && typeof onDropFiles === "function") {
            const dataTransfer = new DataTransfer();
            acceptedFiles.forEach((file) => dataTransfer.items.add(file));
            onDropFiles(dataTransfer.files);
        }

        // Handle unaccepted files
        if (unacceptedFiles.length > 0 && typeof onDropUnacceptedFiles === "function") {
            const unacceptedDataTransfer = new DataTransfer();
            unacceptedFiles.forEach((file) => unacceptedDataTransfer.items.add(file));

            setIsInvalid(true);
            onDropUnacceptedFiles(unacceptedDataTransfer.files);
        }

        // Clear the input value to ensure the same file can be selected again
        if (inputRef.current) {
            inputRef.current.value = "";
        }
    };

    const handleDrop = (event: React.DragEvent<HTMLLabelElement>) => {
        if (isDisabled) return;

        handleDragOut(event);
        processFiles(Array.from(event.dataTransfer.files));
    };

    const handleInputFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        processFiles(Array.from(event.target.files || []));
    };

    return (
        // A label, not a div: clicking anywhere inside the box — padding, icon, hint — opens the
        // picker through the native control rather than through a handler, and the sr-only input
        // it wraps keeps the box reachable and operable from the keyboard.
        <label
            data-dropzone
            htmlFor={id}
            onDragOver={handleDragIn}
            onDragEnter={handleDragIn}
            onDragLeave={handleDragOut}
            onDragEnd={handleDragOut}
            onDrop={handleDrop}
            className={cx(
                "relative flex cursor-pointer flex-col items-center gap-3 rounded-xl bg-primary px-6 py-4 text-tertiary ring-1 outline-brand transition duration-100 ease-linear ring-inset focus-within:outline-2 focus-within:outline-offset-2 motion-reduce:transition-none",
                // Three states, each a step stronger: at rest, a file somewhere over the page, a
                // file over the box itself.
                isDraggingOver ? "scale-[1.02] bg-brand-primary ring-2 ring-brand" : isFileOverWindow ? "scale-[1.01] ring-2 ring-brand" : "ring-secondary",
                isDisabled && "cursor-not-allowed bg-secondary",
                className,
            )}
        >
            <FeaturedIcon
                icon={UploadCloud02}
                color={isDraggingOver || isFileOverWindow ? "brand" : "gray"}
                theme="modern"
                size="md"
                className={cx(
                    "transition duration-100 ease-linear motion-reduce:transition-none",
                    isDraggingOver && "-translate-y-0.5 scale-110",
                    isDisabled && "opacity-50",
                )}
            />

            <div className="flex flex-col gap-1 text-center">
                <div className="flex justify-center gap-1 text-center">
                    <input
                        ref={inputRef}
                        id={id}
                        type="file"
                        className="peer sr-only"
                        disabled={isDisabled}
                        accept={accept}
                        multiple={allowsMultiple}
                        onChange={handleInputFileChange}
                    />
                    {/* Presentational: the label around the whole box is what opens the picker, so
                        a nested button here would fire it a second time. */}
                    <span className="text-sm font-semibold text-brand-secondary">
                        {isFileOverWindow ? "Drop the file here" : "Click to upload"}
                        {!isFileOverWindow && <span className="md:hidden"> and attach files</span>}
                    </span>
                    {!isFileOverWindow && <span className="text-sm max-md:hidden">or drag and drop</span>}
                </div>
                <p className={cx("text-xs transition duration-100 ease-linear", isInvalid && "text-error-primary")}>
                    {hint || "SVG, PNG, JPG or GIF (max. 800x400px)"}
                </p>
            </div>
        </label>
    );
};

export interface FileListItemProps {
    /** The name of the file. */
    name: string;
    /** The size of the file. */
    size: number;
    /** The upload progress of the file. */
    progress: number;
    /** Whether the file failed to upload. */
    failed?: boolean;
    /** The type of the file. */
    type?: ComponentProps<typeof FileIcon>["type"];
    /** The class name of the file list item. */
    className?: string;
    /** The variant of the file icon. */
    fileIconVariant?: ComponentProps<typeof FileTypeIcon>["variant"];
    /** The function to call when the file is deleted. */
    onDelete?: () => void;
    /** The function to call when the file upload is retried. */
    onRetry?: () => void;
}

export const FileListItemProgressBar = ({ name, size, progress, failed, type, fileIconVariant, onDelete, onRetry, className }: FileListItemProps) => {
    const isComplete = progress === 100;

    return (
        <motion.li
            layout="position"
            className={cx(
                "relative flex gap-3 rounded-xl bg-primary p-4 ring-1 ring-secondary transition-shadow duration-100 ease-linear ring-inset",
                failed && "ring-2 ring-error",
                className,
            )}
        >
            <FileTypeIcon className="size-10 shrink-0 dark:hidden" type={type ?? "empty"} theme="light" variant={fileIconVariant ?? "default"} />
            <FileTypeIcon className="size-10 shrink-0 not-dark:hidden" type={type ?? "empty"} theme="dark" variant={fileIconVariant ?? "default"} />

            <div className="flex min-w-0 flex-1 flex-col items-start">
                <div className="flex w-full max-w-full min-w-0 flex-1">
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-secondary">{name}</p>

                        <div className="mt-0.5 flex items-center gap-2">
                            <p className="truncate text-sm whitespace-nowrap text-tertiary">{getReadableFileSize(size)}</p>

                            <hr className="h-3 w-px rounded-t-full rounded-b-full border-none bg-border-primary" />

                            <div className="flex items-center gap-1">
                                {isComplete && <CheckCircle className="size-4 stroke-[2.5px] text-fg-success-primary" />}
                                {isComplete && <p className="text-sm font-medium text-success-primary">Complete</p>}

                                {!isComplete && !failed && <UploadCloud02 className="size-4 stroke-[2.5px] text-fg-quaternary" />}
                                {!isComplete && !failed && <p className="text-sm font-medium text-quaternary">Uploading...</p>}

                                {failed && <XCircle className="size-4 text-fg-error-primary" />}
                                {failed && <p className="text-sm font-medium text-error-primary">Failed</p>}
                            </div>
                        </div>
                    </div>

                    <ButtonUtility color="tertiary" tooltip="Delete" icon={Trash01} size="xs" className="-mt-2 -mr-2 self-start" onClick={onDelete} />
                </div>

                {!failed && (
                    <div className="mt-1 w-full">
                        <ProgressBar labelPosition="right" max={100} min={0} value={progress} />
                    </div>
                )}

                {failed && (
                    <Button color="link-destructive" size="sm" onClick={onRetry} className="mt-1.5">
                        Try again
                    </Button>
                )}
            </div>
        </motion.li>
    );
};

export const FileListItemProgressFill = ({ name, size, progress, failed, type, fileIconVariant, onDelete, onRetry, className }: FileListItemProps) => {
    const isComplete = progress === 100;

    return (
        <motion.li layout="position" className={cx("relative flex gap-3 overflow-hidden rounded-xl bg-primary p-4", className)}>
            {/* Progress fill. */}
            <div
                style={{ transform: `translateX(-${100 - progress}%)` }}
                className={cx("absolute inset-0 size-full bg-secondary transition duration-75 ease-linear", isComplete && "opacity-0")}
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
            />
            {/* Inner ring. */}
            <div
                className={cx(
                    "absolute inset-0 size-full rounded-[inherit] ring-1 ring-secondary transition duration-100 ease-linear ring-inset",
                    failed && "ring-2 ring-error",
                )}
            />
            <FileTypeIcon className="relative size-10 shrink-0 dark:hidden" type={type ?? "empty"} theme="light" variant={fileIconVariant ?? "solid"} />
            <FileTypeIcon className="relative size-10 shrink-0 not-dark:hidden" type={type ?? "empty"} theme="dark" variant={fileIconVariant ?? "solid"} />

            <div className="relative flex min-w-0 flex-1">
                <div className="relative flex min-w-0 flex-1 flex-col items-start">
                    <div className="w-full min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-secondary">{name}</p>

                        <div className="mt-0.5 flex items-center gap-2">
                            <p className="text-sm text-tertiary">{failed ? "Upload failed, please try again" : getReadableFileSize(size)}</p>

                            {!failed && (
                                <>
                                    <hr className="h-3 w-px rounded-t-full rounded-b-full border-none bg-border-primary" />
                                    <div className="flex items-center gap-1">
                                        {isComplete && <CheckCircle className="size-4 stroke-[2.5px] text-fg-success-primary" />}
                                        {!isComplete && <UploadCloud02 className="size-4 stroke-[2.5px] text-fg-quaternary" />}

                                        <p className="text-sm text-tertiary">{progress}%</p>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    {failed && (
                        <Button color="link-destructive" size="sm" onClick={onRetry} className="mt-1.5">
                            Try again
                        </Button>
                    )}
                </div>

                <ButtonUtility color="tertiary" tooltip="Delete" icon={Trash01} size="xs" className="-mt-2 -mr-2 self-start" onClick={onDelete} />
            </div>
        </motion.li>
    );
};

const FileUploadRoot = (props: ComponentPropsWithRef<"div">) => (
    <div {...props} className={cx("flex flex-col gap-4", props.className)}>
        {props.children}
    </div>
);

const FileUploadList = (props: ComponentPropsWithRef<"ul">) => (
    <ul {...props} className={cx("flex flex-col gap-3", props.className)}>
        <AnimatePresence initial={false}>{props.children}</AnimatePresence>
    </ul>
);

export const FileUpload = {
    Root: FileUploadRoot,
    List: FileUploadList,
    DropZone: FileUploadDropZone,
    ListItemProgressBar: FileListItemProgressBar,
    ListItemProgressFill: FileListItemProgressFill,
};

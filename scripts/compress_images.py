from PIL import Image
import os

def compress_and_resize(input_dir, output_dir, size=(400, 400)):
    """
    Compress and resize all PNG images in the input directory and save to output directory.
    """
    # Create output directory if it doesn't exist
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
    
    # Process all PNG files in the input directory
    for filename in os.listdir(input_dir):
        if filename.lower().endswith('.png'):
            input_path = os.path.join(input_dir, filename)
            output_path = os.path.join(output_dir, filename)
            
            # Open and process image
            with Image.open(input_path) as img:
                # Convert to RGBA if not already
                if img.mode != 'RGBA':
                    img = img.convert('RGBA')
                
                # Resize image
                img = img.resize(size, Image.Resampling.LANCZOS)
                
                # Save with compression
                img.save(output_path, 'PNG', optimize=True, quality=85)
            
            print(f"Processed: {filename}")

def main():
    # Process mouth_open images
    compress_and_resize(
        input_dir='overlays/mouth_open',
        output_dir='overlays/mouth_open_compressed'
    )
    
    # Process mouth_closed images
    compress_and_resize(
        input_dir='overlays/mouth_closed',
        output_dir='overlays/mouth_closed_compressed'
    )

if __name__ == '__main__':
    main()
    print("Done! Check the '_compressed' directories for the processed images.") 
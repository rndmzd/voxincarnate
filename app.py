import voxincarnate
import asyncio

if __name__ == '__main__':
    try:
        # Run the main async function from voxincarnate
        asyncio.run(voxincarnate.main())
    except KeyboardInterrupt:
        print("\nShutting down gracefully...")
    